// Client-side neighbor warm. On every time change (and on domain/variable
// change), prefetches the active timestep's neighbors in two tiers:
//
//   ±1 (DIRECT neighbors)  → FULL prefetch via prefetchVariable.
//                            Pulls all blocks of the active variable into
//                            the SHARED browser block cache. When the user
//                            scrubs prev/next, the renderer finds everything
//                            decoded and renders instantly from local cache.
//
//   ±2..±NEIGHBOR_RADIUS    → HEAD probe (`Range: bytes=0-0`).
//   (OUTER neighbors)        Just nudges CF's PoP edge cache via cache-on-
//                            range — the file lands in the local edge cache
//                            but no data crosses to the browser. If the user
//                            scrubs to one of these, the renderer still has
//                            to fetch real data, but the round-trip is local
//                            edge (~50 ms) instead of R2 (~300-500 ms).
//
// Skip-already-warmed via two Sets so rapid scrubbing doesn't refire. When
// the user scrubs and a previously-outer file becomes a direct neighbor,
// we upgrade it from head-probed to full-prefetched.

import { get, writable } from 'svelte/store';

import { WeatherMapLayerFileReader } from '@openmeteo/weather-map-layer';

import { metaJson, modelRun, time } from '$lib/stores/time';
import { domain, variable } from '$lib/stores/variables';
import { omProtocolSettings } from '$lib/stores/om-protocol-settings';
import { fmtModelRun, fmtSelectedTime, getBaseUri } from '$lib/helpers';
import { formatISOUTCWithZ } from '$lib/time-format';

// Outer radius — total ±5 neighbors maintained around the active time.
const NEIGHBOR_RADIUS = 5;

// Inner radius — files within ±DIRECT_RADIUS of active get the full block-
// cache prefetch. Files outside that but within NEIGHBOR_RADIUS get only
// the lightweight head probe.
const DIRECT_RADIUS = 1;

// Shared concurrency across both tiers. Head probes finish in tens of ms
// so they don't bottleneck full prefetches; whichever worker finishes
// first picks up the next task in the queue.
const WARM_CONCURRENCY = 4;

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

// URLs that have been fully prefetched (block cache populated). Strictly
// stronger than head-probed.
const warmedFullUrls = new Set<string>();

// URLs that have been head-probed only (CF PoP edge nudged, no data in
// browser block cache).
const warmedHeadUrls = new Set<string>();

// Single in-flight controller — every new time change aborts the prior
// neighbor warm so we don't pile up requests during fast scrubbing.
let currentController: AbortController | null = null;

const buildOmUrl = (validTime: Date): string | null => {
	const d = get(domain);
	const mr = get(modelRun);
	if (!d || !mr) return null;
	return `${getBaseUri(d)}/data_spatial/${d}/${fmtModelRun(mr)}/${fmtSelectedTime(validTime)}.om`;
};

type NeighborTask = { url: string; mode: 'full' | 'head' };

// Build the list of neighbor URLs + their tier from metaJson.valid_times.
// Skips the active time itself (the renderer is already loading that one).
// Bounds the window at the meta-json horizon edges (start / end of the run).
const computeNeighborTasks = (): NeighborTask[] => {
	const meta = get(metaJson);
	if (!meta?.valid_times?.length) return [];
	const currentTime = get(time);
	if (!currentTime) return [];
	const dateString = formatISOUTCWithZ(currentTime);
	const idx = meta.valid_times.findIndex((s: string) => s === dateString);
	if (idx === -1) return [];
	const tasks: NeighborTask[] = [];
	const start = Math.max(0, idx - NEIGHBOR_RADIUS);
	const end = Math.min(meta.valid_times.length - 1, idx + NEIGHBOR_RADIUS);
	for (let i = start; i <= end; i++) {
		if (i === idx) continue;
		const distance = Math.abs(i - idx);
		const mode: 'full' | 'head' = distance <= DIRECT_RADIUS ? 'full' : 'head';
		const vt = new Date(meta.valid_times[i]);
		const url = buildOmUrl(vt);
		if (url) tasks.push({ url, mode });
	}
	return tasks;
};

// Clear warmed-set + abort any in-flight warm. Called when the cached
// content becomes irrelevant — domain or variable change.
export const resetWarmState = (): void => {
	warmedFullUrls.clear();
	warmedHeadUrls.clear();
	if (currentController) {
		currentController.abort();
		currentController = null;
	}
	popWarmProgress.set({
		status: 'idle',
		domain: get(domain) ?? null,
		done: 0,
		total: 0,
		ok: 0,
		fail: 0
	});
};

// Returns true if `task` still needs to run given the current warmed-state.
const needsWarming = (task: NeighborTask): boolean => {
	if (task.mode === 'full') {
		// Full mode: only skip if this URL is already fully warmed. A
		// previously head-probed URL still needs upgrading to full.
		return !warmedFullUrls.has(task.url);
	}
	// Head mode: skip if either tier already covers it. Full is strictly
	// stronger than head, so a fully-warmed URL doesn't need re-probing.
	return !warmedFullUrls.has(task.url) && !warmedHeadUrls.has(task.url);
};

// Fire prefetch for any unwarmed neighbors of the current time. Idempotent
// per (URL × tier × session).
export const warmNeighbors = async (): Promise<void> => {
	if (typeof window === 'undefined') return;

	if (currentController) currentController.abort();
	const controller = new AbortController();
	currentController = controller;
	const { signal } = controller;

	const candidates = computeNeighborTasks();
	const todo = candidates.filter(needsWarming);
	if (!todo.length) return;

	// Order: full prefetches first (they take longer, get them dispatched
	// early), then head probes (fast, fill in around them).
	todo.sort((a, b) => (a.mode === 'full' ? -1 : 1) - (b.mode === 'full' ? -1 : 1));

	const settings = get(omProtocolSettings);
	const cache = settings.fileReaderConfig?.cache;
	if (!cache) return; // SSR or cache not yet ready

	const currentVariable = get(variable);
	const currentDomain = get(domain) ?? null;

	popWarmProgress.set({
		status: 'running',
		domain: currentDomain,
		done: 0,
		total: todo.length,
		ok: 0,
		fail: 0
	});

	const queue: NeighborTask[] = [...todo];
	const workers = Array.from({ length: WARM_CONCURRENCY }, async () => {
		// Each worker lazy-creates a reader on first full-prefetch task.
		// `setToOmFile` is stateful per-reader so concurrent calls on a
		// single reader would race.
		let reader: WeatherMapLayerFileReader | null = null;
		try {
			while (queue.length) {
				if (signal.aborted) return;
				const task = queue.shift();
				if (!task) return;
				// Re-check skip flags — another worker may have just warmed
				// this URL between when we built the queue and now.
				if (!needsWarming(task)) continue;

				let ok = false;
				try {
					if (task.mode === 'full') {
						if (!reader) {
							reader = new WeatherMapLayerFileReader({
								cache,
								useSAB: settings.fileReaderConfig?.useSAB
							});
						}
						await reader.setToOmFile(task.url);
						if (signal.aborted) return;
						await reader.prefetchVariable(currentVariable, null, signal);
						warmedFullUrls.add(task.url);
						// Promote: a previously head-probed URL is now strictly
						// covered by the full-warmed set.
						warmedHeadUrls.delete(task.url);
					} else {
						// Head probe — single 1-byte range request, drained.
						// CF's cache-on-range behavior pulls the full file
						// into the PoP edge cache as a side effect.
						const res = await fetch(task.url, {
							method: 'GET',
							headers: { Range: 'bytes=0-0' },
							signal
						});
						await res.body?.cancel().catch(() => {});
						if (res.ok) warmedHeadUrls.add(task.url);
					}
					ok = true;
				} catch (err) {
					if ((err as { name?: string } | undefined)?.name === 'AbortError') return;
					console.debug('[neighbor-warm] failed', task.url, err);
				}
				popWarmProgress.update((s) => ({
					...s,
					done: s.done + 1,
					ok: s.ok + (ok ? 1 : 0),
					fail: s.fail + (ok ? 0 : 1)
				}));
			}
		} finally {
			reader?.dispose();
		}
	});
	await Promise.all(workers);

	if (!signal.aborted) {
		popWarmProgress.update((s) => ({ ...s, status: 'done' }));
	}
};

// Backwards-compat wrapper for existing callers (+page.svelte's
// domain.subscribe handler, and the manual "Warm" button in cache-settings).
// Resets the warmed-sets for a new domain, then fires the neighbor warm
// around the current time.
export const warmCurrentPoP = async (newDomain: string): Promise<void> => {
	if (!newDomain) return;
	resetWarmState();
	await warmNeighbors();
};

// Compatibility export — the old UI-surface "warm horizon hours" label
// no longer applies; we always warm ±NEIGHBOR_RADIUS timesteps regardless
// of model. Kept exported so cache-settings.svelte doesn't break on import.
export const warmHorizonHoursFor = (_domainValue: string): number => NEIGHBOR_RADIUS;
