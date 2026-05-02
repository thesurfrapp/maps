// Client-side per-PoP cache warm. For each .om URL in the horizon, fires a
// single suffix-syntax tail Range request — `Range: bytes=-1` — which asks
// for just the last byte of the file. The act of CF having to satisfy a
// "back of file" range is what nudges the edge cache into a full-file fill,
// turning later scrub fetches from `age: 0` regional→edge fills into true
// `age > 0` edge HITs.
//
// Suffix syntax requires server-side support — see `parseRange` in
// `functions/tiles/[[path]].ts`, which forwards suffix to R2 via
// `{ range: { suffix: N } }`.
//
// Invoked automatically on domain switch in `+page.svelte`; also available
// as a manual "Warm this PoP" button in the Settings sheet.
//
// Horizon must mirror the server-side warmer (functions/lib/warmer.ts) —
// warming files past the server's cap just hits 404s.

import { writable } from 'svelte/store';

const DEFAULT_WARM_HORIZON_HOURS = 72;
const EXTENDED_WARM_HORIZON_HOURS = 5 * 24;
const EXTENDED_WARM_DOMAINS = new Set([
	'ncep_gfs013',
	'ncep_gfs025',
	'ecmwf_ifs025',
	'dwd_icon',
	'dwd_icon_d2'
]);
export const warmHorizonHoursFor = (domain: string): number =>
	EXTENDED_WARM_DOMAINS.has(domain) ? EXTENDED_WARM_HORIZON_HOURS : DEFAULT_WARM_HORIZON_HOURS;
const WARM_CONCURRENCY = 4;
const META_BASE = 'https://tiles.thesurfr.app/data_spatial';

// Tail probe size. Just enough bytes to make CF actually treat this as a
// distinct range request that needs the back-of-file region in edge cache.
// Empirically, 1 byte appears sufficient — the act of requesting the tail
// matters more than the size.
const TAIL_PROBE_BYTES = 1;

// Sparse-walk step. On a probe whose response shows the file is already
// fully populated at this PoP edge, we trust the next (SPARSE_STEP-1)
// neighbors are also warm and skip them. The first cold probe flips us into
// dense mode for the remainder.
const SPARSE_STEP = 5;

// Threshold for "this file's edge entry is already populated at this PoP."
// Reads the `Age` response header. `cf-cache-status: HIT` with `age: 0`
// means a fresh regional→edge fill — i.e. this PoP didn't actually have it
// locally yet. `age >= MIN_WARM_AGE_SEC` means a real, settled edge entry.
// 2 seconds is small enough that a recent warm cycle still counts as warm,
// big enough to filter out fresh regional→edge fills (which always show
// `age: 0`).
const MIN_WARM_AGE_SEC = 2;

export type PopWarmState = {
	status: 'idle' | 'running' | 'done' | 'failed';
	domain: string | null;
	done: number;
	total: number;
	ok: number;
	fail: number;
};

export const popWarmProgress = writable<PopWarmState>({
	status: 'idle',
	domain: null,
	done: 0,
	total: 0,
	ok: 0,
	fail: 0
});

const fmtValidTime = (iso: string): string => {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
};

const fmtRunPath = (iso: string): string => {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
};

const runBounded = async (
	items: string[],
	limit: number,
	fn: (item: string) => Promise<void>
): Promise<void> => {
	let i = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const idx = i++;
			if (idx >= items.length) return;
			await fn(items[idx]);
		}
	});
	await Promise.all(workers);
};

// In-flight guard — abort the previous warm when a new domain is selected
// before the previous one finishes. Prevents HTTP/2 stream buildup on fast
// domain-switching.
let inFlightController: AbortController | null = null;

export const warmCurrentPoP = async (domain: string): Promise<void> => {
	if (!domain) return;
	if (inFlightController) inFlightController.abort();
	const controller = new AbortController();
	inFlightController = controller;
	const { signal } = controller;

	popWarmProgress.set({
		status: 'running',
		domain,
		done: 0,
		total: 0,
		ok: 0,
		fail: 0
	});

	try {
		const metaRes = await fetch(`${META_BASE}/${domain}/latest.json`, {
			cache: 'no-store',
			signal
		});
		if (!metaRes.ok) throw new Error(`latest.json ${metaRes.status}`);
		const meta = (await metaRes.json()) as {
			reference_time: string;
			valid_times: string[];
		};
		const refMs = new Date(meta.reference_time).getTime();
		const cutoffMs = refMs + warmHorizonHoursFor(domain) * 3600 * 1000;
		const capped = meta.valid_times.filter((iso) => new Date(iso).getTime() <= cutoffMs);
		const runPath = fmtRunPath(meta.reference_time);

		popWarmProgress.update((s) => ({ ...s, total: capped.length }));

		const probeOne = async (
			iso: string
		): Promise<{ ok: boolean; isWarm: boolean; aborted: boolean }> => {
			const url = `${META_BASE}/${domain}/${runPath}/${fmtValidTime(iso)}.om`;
			try {
				const res = await fetch(url, {
					method: 'GET',
					headers: { Range: `bytes=-${TAIL_PROBE_BYTES}` },
					signal
				});
				await res.body?.cancel().catch(() => {});
				if (!res.ok) {
					return { ok: false, isWarm: false, aborted: false };
				}
				// Age header is exposed via the Pages Function's CORS list.
				// `cf-cache-status: HIT` + `age >= MIN_WARM_AGE_SEC` means
				// the edge has settled this object — neighbors warmed in the
				// same prior cycle are very likely also settled.
				const cfCacheStatus = res.headers.get('cf-cache-status') ?? '';
				const ageHeader = res.headers.get('age');
				const ageSec = ageHeader ? parseInt(ageHeader, 10) : 0;
				const isWarm =
					cfCacheStatus.toUpperCase() === 'HIT' &&
					Number.isFinite(ageSec) &&
					ageSec >= MIN_WARM_AGE_SEC;
				return { ok: true, isWarm, aborted: false };
			} catch (err) {
				if ((err as { name?: string } | undefined)?.name === 'AbortError') {
					return { ok: false, isWarm: false, aborted: true };
				}
				return { ok: false, isWarm: false, aborted: false };
			}
		};

		// Sparse probe phase: walk the timeline serially with step=SPARSE_STEP.
		// A response with Age >= MIN_WARM_AGE_SEC means this PoP's edge entry
		// for the file is settled (not a fresh regional→edge fill). Neighbors
		// were almost certainly warmed in the same prior cycle, so we trust
		// them and skip ahead. On the first non-warm probe we record
		// `densePivot` and switch to dense parallel warming for the remainder.
		let densePivot = -1;
		for (let i = 0; i < capped.length; ) {
			if (signal.aborted) return;
			const { ok, isWarm, aborted } = await probeOne(capped[i]);
			if (aborted) return;

			if (ok && isWarm) {
				const advance = Math.min(SPARSE_STEP, capped.length - i);
				popWarmProgress.update((s) => ({
					...s,
					done: s.done + advance,
					ok: s.ok + advance
				}));
				i += SPARSE_STEP;
			} else {
				popWarmProgress.update((s) => ({
					...s,
					done: s.done + 1,
					ok: s.ok + (ok ? 1 : 0),
					fail: s.fail + (ok ? 0 : 1)
				}));
				densePivot = i;
				break;
			}
		}

		if (densePivot >= 0 && !signal.aborted) {
			// Backfill the up-to-(SPARSE_STEP-1) skipped neighbors before the
			// pivot — they sit next to a known-cold probe so they're likely
			// not settled at edge yet. Then fan out across the rest of the
			// horizon.
			const backfillBefore: number[] = [];
			for (let j = Math.max(0, densePivot - SPARSE_STEP + 1); j < densePivot; j++) {
				backfillBefore.push(j);
			}
			const denseAfter: number[] = [];
			for (let j = densePivot + 1; j < capped.length; j++) {
				denseAfter.push(j);
			}

			// Undo the trust-bumps for indices we previously claimed as warm
			// but will now re-fetch (otherwise the dense phase double-counts
			// them).
			if (backfillBefore.length > 0) {
				popWarmProgress.update((s) => ({
					...s,
					done: s.done - backfillBefore.length,
					ok: s.ok - backfillBefore.length
				}));
			}

			const denseItems = [...backfillBefore, ...denseAfter].map((idx) => capped[idx]);
			await runBounded(denseItems, WARM_CONCURRENCY, async (iso) => {
				if (signal.aborted) return;
				const { ok, aborted } = await probeOne(iso);
				if (aborted) return;
				popWarmProgress.update((s) => ({
					...s,
					done: s.done + 1,
					ok: s.ok + (ok ? 1 : 0),
					fail: s.fail + (ok ? 0 : 1)
				}));
			});
		}

		if (!signal.aborted) {
			popWarmProgress.update((s) => ({ ...s, status: 'done' }));
		}
	} catch (err) {
		if ((err as { name?: string } | undefined)?.name === 'AbortError') return;
		console.warn('[popWarm] failed', err);
		popWarmProgress.update((s) => ({ ...s, status: 'failed' }));
	} finally {
		if (inFlightController === controller) {
			inFlightController = null;
		}
	}
};
