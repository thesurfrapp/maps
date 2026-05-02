// Client-side per-PoP cache warm. Fires 1-byte Range requests for the
// horizon of .om URLs of the given domain so CF's cache-on-range
// behaviour pulls each full file into the local PoP's edge cache.
// Subsequent scrubs inside that window serve from local edge
// (~100 ms) instead of first-hit origin path (up to several seconds).
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
const META_BASE = 'https://maps.thesurfr.app/tiles/data_spatial';

// Adaptive walk tuning. Probe every Nth file sequentially; if response is fast
// (PoP edge cache hit) trust the (N-1) skipped neighbors are also warm and keep
// stepping. The first slow probe flips us into dense mode — 1-by-1 from there,
// in parallel — and backfills the just-skipped neighbors (they sit next to a
// known-cold probe so they're likely cold too).
const SPARSE_STEP = 5;
// CF edge hit ≈ 50–200 ms; cold R2/origin fetch ≈ 500–2000 ms. 500 ms gives
// margin above warm hits while staying well below cold misses.
const FAST_PROBE_MS = 500;

// Tail probe size — last N bytes of each file. Sent as a suffix Range
// (`bytes=-N`) so we don't need a head request to learn the file size.
// The act of CF having to satisfy a "back of file" range is what nudges
// the edge cache layer into a full-file cache fill — we don't actually
// care about the bytes returned.
const TAIL_PROBE_BYTES = 1;

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
		): Promise<{ ok: boolean; elapsedMs: number; aborted: boolean }> => {
			const url = `${META_BASE}/${domain}/${runPath}/${fmtValidTime(iso)}.om`;
			const t0 = performance.now();
			try {
				// Single request: tail-only suffix range. No HEAD, no
				// `bytes=0-0` head probe. Suffix syntax requires server-side
				// support — handled by parseRange in
				// functions/tiles/[[path]].ts.
				const res = await fetch(url, {
					method: 'GET',
					headers: { Range: `bytes=-${TAIL_PROBE_BYTES}` },
					signal
				});
				await res.body?.cancel().catch(() => {});
				return { ok: res.ok, elapsedMs: performance.now() - t0, aborted: false };
			} catch (err) {
				if ((err as { name?: string } | undefined)?.name === 'AbortError') {
					return { ok: false, elapsedMs: performance.now() - t0, aborted: true };
				}
				return { ok: false, elapsedMs: performance.now() - t0, aborted: false };
			}
		};

		// Sparse probe phase: walk the timeline serially with step=SPARSE_STEP.
		// A fast hit on index i lets us trust [i+1, i+SPARSE_STEP-1] are also
		// PoP-warm (they were almost certainly fetched alongside i in a prior
		// warm). On the first slow/failed probe we record `densePivot` and
		// switch to dense parallel fetching for the remainder.
		let densePivot = -1;
		for (let i = 0; i < capped.length; ) {
			if (signal.aborted) return;
			const { ok, elapsedMs, aborted } = await probeOne(capped[i]);
			if (aborted) return;

			if (ok && elapsedMs < FAST_PROBE_MS) {
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
			// pivot — they sit next to a known-cold probe so they're likely cold
			// too. Then fan out across the rest of the horizon.
			const backfillBefore: number[] = [];
			for (let j = Math.max(0, densePivot - SPARSE_STEP + 1); j < densePivot; j++) {
				backfillBefore.push(j);
			}
			const denseAfter: number[] = [];
			for (let j = densePivot + 1; j < capped.length; j++) {
				denseAfter.push(j);
			}

			// Undo the trust-bump for indices we previously claimed as warm but
			// will now re-fetch (otherwise the dense phase double-counts them).
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
