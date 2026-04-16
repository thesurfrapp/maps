// CF cache purge + re-warm, called by the cron worker AFTER a per-domain
// `/tiles/_warmer-trigger` call reports a fresh `warmed` run.
//
// Why this lives in the cron worker (not the Pages Function):
//   * Purge is a scheduled-only concern — no client request should ever
//     cause a purge. Keeping the CF API token out of the Pages Function
//     shrinks the blast radius.
//
// Cache Reserve makes the re-warm globally meaningful:
//   * A single `fetch(url, { cf: { cacheEverything: true } })` from this
//     cron worker populates Cache Reserve (the global, persistent tier
//     sitting between edge PoPs and origin).
//   * After a purge, the re-warm fills Cache Reserve. Subsequent user
//     misses at any PoP worldwide get Cache Reserve HITs (~100-200 ms),
//     instead of going all the way to our Pages Function + R2 (up to 6 s
//     for the 168 MB icon-global).
//   * Without Cache Reserve enabled, this fetch would only fill the
//     cron-worker PoP's own edge — useless for other PoPs. We enabled
//     Cache Reserve on the zone so this is now genuinely useful.

const API_BASE = 'https://api.cloudflare.com/client/v4';
const PURGE_BATCH = 30; // Free-plan limit per purge_cache call.

// Match the cron-side warm horizon to the server-side warm horizon
// (MAX_HORIZON_HOURS in functions/lib/warmer.ts). Any validTime R2 has,
// CF Cache Reserve should also have pre-filled.
const PURGE_HORIZON_HOURS = 72;

// Per-URL warm concurrency. Kept low so we don't saturate the cron PoP's
// outbound, and Open-Meteo sees at most a handful of fetches per cron
// tick (each stripped URL -> Pages Function -> R2, so upstream is not
// touched on the warm path — but R2/Pages Function still have capacity
// limits).
const REWARM_CONCURRENCY = 4;

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
	const cutoffMs = refMs + PURGE_HORIZON_HOURS * 3600 * 1000;
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
};

// Full-file GET with cacheEverything. The Pages Function returns a 200 with
// the full body from R2; CF's Cache Rule + cacheEverything populate Cache
// Reserve on the way back. Body is drained as a stream (low memory) and
// discarded.
const rewarmOne = async (url: string): Promise<RewarmOutcome> => {
	const t0 = Date.now();
	try {
		const res = await fetch(url, {
			method: 'GET',
			cf: { cacheEverything: true, cacheTtl: 30 * 86400 }
		});
		const contentLength = Number(res.headers.get('Content-Length') ?? '0');
		const cfCacheStatus = res.headers.get('CF-Cache-Status');
		let bytes = 0;
		const reader = res.body?.getReader();
		if (reader) {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) bytes += value.byteLength;
			}
		}
		return { url, status: res.status, ms: Date.now() - t0, bytes, contentLength, cfCacheStatus };
	} catch {
		return { url, status: -1, ms: Date.now() - t0, bytes: 0, contentLength: 0, cfCacheStatus: null };
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

export type PurgeAndRewarmResult = {
	domain: string;
	urls: number;
	purge: { batches: Array<{ ok: boolean; status: number }>; totalMs: number };
	rewarm: {
		ok: number;
		fail: number;
		totalMs: number;
		totalBytes: number;
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
): Promise<PurgeAndRewarmResult> => {
	const capped = capValidTimes(validTimes, referenceTime);
	const urls = capped.map((iso) => strippedUrl(origin, domain, iso));

	// Step 1: purge (global, all tiers including Cache Reserve).
	const tPurge = Date.now();
	const batches: Array<{ ok: boolean; status: number }> = [];
	for (const batch of chunk(urls, PURGE_BATCH)) {
		const res = await purgeBatch(env, batch);
		batches.push({ ok: res.ok, status: res.status });
		if (!res.ok) console.warn('[purge] batch failed', res.status, res.body);
	}
	const purgeMs = Date.now() - tPurge;

	// Step 2: re-warm. Single fetch per URL populates Cache Reserve globally.
	const tRewarm = Date.now();
	const rewarmResults = await runBounded(urls, REWARM_CONCURRENCY, rewarmOne);
	const ok = rewarmResults.filter((r) => r.status >= 200 && r.status < 400).length;
	const fail = rewarmResults.length - ok;
	const totalBytes = rewarmResults.reduce((s, r) => s + r.bytes, 0);
	const byCfCacheStatus: Record<string, number> = {};
	for (const r of rewarmResults) {
		const k = r.cfCacheStatus ?? 'null';
		byCfCacheStatus[k] = (byCfCacheStatus[k] ?? 0) + 1;
	}
	// A body that came back short of Content-Length means the stream was cut
	// (OOM, abort, etc) and CF likely didn't finalise the cache entry.
	const shortBodies = rewarmResults
		.filter((r) => r.contentLength > 0 && r.bytes < r.contentLength)
		.map((r) => ({ url: r.url, bytes: r.bytes, contentLength: r.contentLength }));

	return {
		domain,
		urls: urls.length,
		purge: { batches, totalMs: purgeMs },
		rewarm: {
			ok,
			fail,
			totalMs: Date.now() - tRewarm,
			totalBytes,
			byCfCacheStatus,
			shortBodies
		}
	};
};
