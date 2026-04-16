// Client-side per-PoP cache warm. Fires 1-byte Range requests for the
// next 72 h of .om URLs of the given domain so CF's cache-on-range
// behaviour pulls each full file into the local PoP's edge cache.
// Subsequent scrubs inside that 72 h window serve from local edge
// (~100 ms) instead of first-hit origin path (up to several seconds).
//
// Invoked automatically on domain switch in `+page.svelte`; also available
// as a manual "Warm this PoP" button in the Settings sheet.

import { writable } from 'svelte/store';

const WARM_HORIZON_HOURS = 72;
const WARM_CONCURRENCY = 4;
const META_BASE = 'https://maps.thesurfr.app/tiles/data_spatial';

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
		const metaRes = await fetch(`${META_BASE}/${domain}/meta.json`, { signal });
		if (!metaRes.ok) throw new Error(`meta.json ${metaRes.status}`);
		const meta = (await metaRes.json()) as {
			reference_time: string;
			valid_times: string[];
		};
		const refMs = new Date(meta.reference_time).getTime();
		const cutoffMs = refMs + WARM_HORIZON_HOURS * 3600 * 1000;
		const capped = meta.valid_times.filter((iso) => new Date(iso).getTime() <= cutoffMs);

		popWarmProgress.update((s) => ({ ...s, total: capped.length }));

		await runBounded(capped, WARM_CONCURRENCY, async (iso) => {
			if (signal.aborted) return;
			const url = `${META_BASE}/${domain}/${fmtValidTime(iso)}.om`;
			try {
				const res = await fetch(url, {
					method: 'GET',
					headers: { Range: 'bytes=0-0' },
					signal
				});
				await res.body?.cancel().catch(() => {});
				popWarmProgress.update((s) => ({
					...s,
					done: s.done + 1,
					ok: s.ok + (res.ok ? 1 : 0),
					fail: s.fail + (res.ok ? 0 : 1)
				}));
			} catch (err) {
				if ((err as { name?: string } | undefined)?.name === 'AbortError') return;
				popWarmProgress.update((s) => ({
					...s,
					done: s.done + 1,
					fail: s.fail + 1
				}));
			}
		});

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
