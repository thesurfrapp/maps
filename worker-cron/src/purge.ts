// CF cache purge + re-warm helpers, called by the cron worker AFTER a per-
// domain `/tiles/_warmer-trigger` call reports a fresh `warmed` run.
//
// Why this lives in the cron worker and not the Pages Function:
//   * Purge is a scheduled-only concern — no client request should ever cause
//     a purge. Keeping the CF API token out of the Pages Function shrinks the
//     blast radius.
//   * The Pages Function already does plenty per tick (R2 reads/writes, old-
//     run cleanup); offloading the CF-cache dance keeps each layer focused.
//
// Design:
//   * Client-facing URLs are STRIPPED (no runPath) — stable across runs.
//   * When a new run swaps, those URLs now map to fresh R2 content but CF
//     edge still holds the old run's body cached against the same URL → we
//     must purge.
//   * After purge, we re-populate CF cache by fetching each stripped URL
//     once with `cf: { cacheEverything: true, cacheTtl: 30d }`. The Pages
//     Function sees a plain GET (no Range) → returns a 200 with the full
//     file → `cacheEverything` forces CF to cache it despite Pages-Function
//     responses being `DYNAMIC` by default. Smart Tiered Cache propagates
//     the entry so all PoPs can HIT without each having to warm.
//   * Cap the re-warm horizon at 24 h of validTimes to bound R2 egress.
//     Users rarely scrub past that; anything further falls through to the
//     existing R2-tier safety net on first hit.

const API_BASE = 'https://api.cloudflare.com/client/v4';
const PURGE_BATCH = 30; // Free-plan limit per purge_cache call.
const REWARM_CONCURRENCY = 4;
// Match the server-side warmer cap (MAX_HORIZON_HOURS in functions/lib/warmer.ts)
// so anything R2 holds also gets CF-edge-pre-warmed — otherwise hours 24-72
// cost the first visitor a MISS even though R2 has the bytes. Traffic from
// cron → Pages Function → R2 stays inside CF network (free), so no egress hit.
const REWARM_HORIZON_HOURS = 72;

type PurgeEnv = {
	CF_PURGE_TOKEN?: string;
	CF_ZONE_ID?: string;
};

// Build a stripped client-facing URL for a given (domain, validTime).
// Must exactly match what the client constructs in `src/lib/url.ts`.
const fmtValidTime = (iso: string): string => {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
};

const strippedUrl = (origin: string, domain: string, iso: string): string =>
	`${origin}/tiles/data_spatial/${domain}/${fmtValidTime(iso)}.om`;

const capValidTimes = (validTimes: string[], referenceTime: string): string[] => {
	const refMs = new Date(referenceTime).getTime();
	const cutoffMs = refMs + REWARM_HORIZON_HOURS * 3600 * 1000;
	return validTimes.filter((iso) => new Date(iso).getTime() <= cutoffMs);
};

const chunk = <T>(arr: T[], size: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
};

const purgeBatch = async (
	env: PurgeEnv,
	files: string[]
): Promise<{ ok: boolean; status: number; body?: string }> => {
	if (!env.CF_PURGE_TOKEN || !env.CF_ZONE_ID) {
		return { ok: false, status: 0, body: 'CF_PURGE_TOKEN or CF_ZONE_ID missing' };
	}
	const res = await fetch(`${API_BASE}/zones/${env.CF_ZONE_ID}/purge_cache`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.CF_PURGE_TOKEN}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ files })
	});
	const body = await res.text().catch(() => '');
	return { ok: res.ok, status: res.status, body: body.slice(0, 300) };
};

type RewarmOutcome = {
	url: string;
	status: number;
	ms: number;
	bytes: number;
	contentLength: number;
	cfCacheStatus: string | null;
	error?: string;
};

const rewarmOne = async (url: string): Promise<RewarmOutcome> => {
	const t0 = Date.now();
	try {
		// GET without a Range header so the Pages Function returns the full 200
		// body — that's the shape CF will cache and slice ranges from later.
		const res = await fetch(url, {
			method: 'GET',
			cf: {
				cacheEverything: true,
				cacheTtl: 30 * 86400
			}
		});
		const contentLength = Number(res.headers.get('Content-Length') ?? '0');
		const cfCacheStatus = res.headers.get('CF-Cache-Status');
		// Drain the body as a stream — lower memory than arrayBuffer() (which
		// would buffer all 30+ MB in the isolate, then at concurrency=4 bump us
		// into OOM). CF finalises the cache write as bytes pass through.
		let bytes = 0;
		const reader = res.body?.getReader();
		if (reader) {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) bytes += value.byteLength;
			}
		}
		return {
			url,
			status: res.status,
			ms: Date.now() - t0,
			bytes,
			contentLength,
			cfCacheStatus
		};
	} catch (err) {
		return {
			url,
			status: -1,
			ms: Date.now() - t0,
			bytes: 0,
			contentLength: 0,
			cfCacheStatus: null,
			error: String(err)
		};
	}
};

const runBounded = async <T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>
): Promise<R[]> => {
	const results: R[] = new Array(items.length);
	let i = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const idx = i++;
			if (idx >= items.length) return;
			results[idx] = await fn(items[idx]);
		}
	});
	await Promise.all(workers);
	return results;
};

export type PurgeRewarmResult = {
	domain: string;
	urls: number;
	purgeBatches: Array<{ ok: boolean; status: number }>;
	rewarmed: {
		ok: number;
		fail: number;
		totalMs: number;
		totalBytes: number;
		totalContentLength: number;
		byCfCacheStatus: Record<string, number>;
		shortBodies: Array<{ url: string; bytes: number; contentLength: number }>;
	};
};

export const purgeAndRewarmDomain = async (
	env: PurgeEnv,
	origin: string,
	domain: string,
	referenceTime: string,
	validTimes: string[]
): Promise<PurgeRewarmResult> => {
	const capped = capValidTimes(validTimes, referenceTime);
	const urls = capped.map((iso) => strippedUrl(origin, domain, iso));

	// Purge in batches so we respect the 30-URL free-plan limit.
	const purgeBatches: PurgeRewarmResult['purgeBatches'] = [];
	for (const batch of chunk(urls, PURGE_BATCH)) {
		const res = await purgeBatch(env, batch);
		purgeBatches.push({ ok: res.ok, status: res.status });
		if (!res.ok) {
			console.warn('[purge] batch failed', res.status, res.body);
		}
	}

	// Re-warm — full-file GETs with cacheEverything.
	const t0 = Date.now();
	const rewarmResults = await runBounded(urls, REWARM_CONCURRENCY, rewarmOne);
	const ok = rewarmResults.filter((r) => r.status >= 200 && r.status < 400).length;
	const fail = rewarmResults.length - ok;
	const totalBytes = rewarmResults.reduce((s, r) => s + r.bytes, 0);
	const totalContentLength = rewarmResults.reduce((s, r) => s + r.contentLength, 0);
	const byCfCacheStatus: Record<string, number> = {};
	for (const r of rewarmResults) {
		const key = r.cfCacheStatus ?? 'null';
		byCfCacheStatus[key] = (byCfCacheStatus[key] ?? 0) + 1;
	}
	// Catch silently-truncated downloads: if bytes < Content-Length, cache didn't
	// get the full file — the re-warm didn't do what we think it did.
	const shortBodies = rewarmResults
		.filter((r) => r.contentLength > 0 && r.bytes < r.contentLength)
		.map((r) => ({ url: r.url, bytes: r.bytes, contentLength: r.contentLength }));

	return {
		domain,
		urls: urls.length,
		purgeBatches,
		rewarmed: {
			ok,
			fail,
			totalMs: Date.now() - t0,
			totalBytes,
			totalContentLength,
			byCfCacheStatus,
			shortBodies
		}
	};
};
