// Cloudflare Pages Function — tile proxy with three-tier caching.
//
//   Browser ─► CF edge cache (auto-cached via our Cache-Control headers)
//              └► miss ─► this Function runs
//                         ├► R2 (persistent cache — our DIY Cache Reserve)
//                         │   └► HIT: serve from R2 (edge auto-caches the response)
//                         │   └► MISS: go to origin, tee body, stream to R2 + client
//                         └► origin (Open-Meteo) — last resort
//
// Why R2 instead of CF Cache Reserve?
//   CF Cache Reserve is gated behind Smart Shield Advanced ($50/mo). R2 gives us
//   the same persistence (single global store, readable from any PoP) for ~$0.08/mo
//   at our volume, with egress free inside the CF network.
//
// Range handling:
//   R2 natively supports byte-range reads, so `GET` with `Range` on an R2-HIT
//   is served directly with `206 Partial Content`. On R2-MISS with a Range, we
//   forward the Range to origin (fast 206 for the client) AND kick off a
//   background full-file R2 fill via waitUntil so the next user hits R2.
//
// Bindings (configured in the Pages project dashboard):
//   TILE_CACHE — R2 bucket (see Pages project → Settings → Functions → R2 bindings)
//
// Cache-lifetime model:
//   * `.om` files       — immutable per (domain, ref_time, forecast_time). 30 days.
//   * `meta.json`       — per-run, immutable. 30 days.
//   * `latest.json`     — flips on new run publish. 5 min so clients lag warmer.
//   * `in-progress.json`— writing run. 30 s.
//   * 404s — 1 hour (horizon doesn't change within a run).

interface Env {
	TILE_CACHE: R2Bucket;
}

const UPSTREAM_HOST = 'https://map-tiles.open-meteo.com';

const OM_FILE_TTL = 60 * 60 * 24 * 30;
const META_JSON_TTL = 60 * 60 * 24 * 30;
const LATEST_JSON_TTL = 60 * 5;
const IN_PROGRESS_JSON_TTL = 30;
const ERROR_404_TTL = 60 * 60;

const FORCE_REFRESH_HEADER = 'X-Surfr-Force-Refresh';
const WARM_HEADER = 'X-Surfr-Warm';
const CACHE_STATUS_HEADER = 'X-Surfr-Cache-Status';

// Don't persist JSON indexes to R2 — they change with every new model run and
// don't benefit from the persistence. Only .om tile files go through R2.
const R2_CACHEABLE = (path: string) => path.endsWith('.om');

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': `Range, If-Match, If-None-Match, If-Modified-Since, ${FORCE_REFRESH_HEADER}, ${WARM_HEADER}`,
	'Access-Control-Expose-Headers':
		'ETag, Content-Range, Content-Length, Accept-Ranges, X-Surfr-Cache-Status, X-Surfr-Refreshed, X-Surfr-Upstream-Ms',
	'Access-Control-Max-Age': '3000'
};

const pickTtl = (path: string): number => {
	if (path.endsWith('.om')) return OM_FILE_TTL;
	if (path.endsWith('/latest.json')) return LATEST_JSON_TTL;
	if (path.endsWith('/in-progress.json')) return IN_PROGRESS_JSON_TTL;
	if (path.endsWith('/meta.json')) return META_JSON_TTL;
	return LATEST_JSON_TTL;
};

// Parse "bytes=start-end" → { offset, length } for R2 `get` range option.
const parseRange = (
	value: string
): { offset: number; length: number; end: number } | null => {
	const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim());
	if (!match) return null;
	const offset = Number(match[1]);
	if (!Number.isFinite(offset)) return null;
	if (match[2] === '') {
		// Open-ended (rare from our library, but support it): we'll cap after
		// reading R2 object size.
		return { offset, length: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER };
	}
	const end = Number(match[2]);
	if (!Number.isFinite(end) || end < offset) return null;
	return { offset, length: end - offset + 1, end };
};

// Background fill: fetch full file from origin (no Range) and put into R2 once.
// Uses waitUntil so it outlives the request. Skips if the object already exists.
const warmR2 = async (env: Env, r2Key: string, upstreamUrl: string): Promise<void> => {
	try {
		const existing = await env.TILE_CACHE.head(r2Key);
		if (existing) return;
		const res = await fetch(upstreamUrl);
		if (!res.ok || !res.body) return;
		await env.TILE_CACHE.put(r2Key, res.body, {
			httpMetadata: {
				contentType: res.headers.get('content-type') ?? 'application/octet-stream'
			},
			customMetadata: {
				sourceUrl: upstreamUrl,
				cachedAt: new Date().toISOString()
			}
		});
	} catch (err) {
		console.warn('[r2-warm] failed', r2Key, err);
	}
};

// Build a Response from an R2 object. Handles Range (206) vs full (200).
const r2ToResponse = (
	r2Obj: R2ObjectBody,
	rangeReq: { offset: number; end: number } | null,
	totalSize: number,
	ttl: number
): Response => {
	const headers = new Headers();
	for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
	headers.set(
		'Content-Type',
		r2Obj.httpMetadata?.contentType ?? 'application/octet-stream'
	);
	headers.set('Cache-Control', `public, max-age=${ttl}`);
	headers.set(CACHE_STATUS_HEADER, 'HIT-R2');
	headers.set('Accept-Ranges', 'bytes');
	if (r2Obj.httpEtag) headers.set('ETag', r2Obj.httpEtag);

	if (rangeReq) {
		const effectiveEnd = Math.min(rangeReq.end, totalSize - 1);
		const length = effectiveEnd - rangeReq.offset + 1;
		headers.set('Content-Range', `bytes ${rangeReq.offset}-${effectiveEnd}/${totalSize}`);
		headers.set('Content-Length', String(length));
		return new Response(r2Obj.body, { status: 206, headers });
	}

	headers.set('Content-Length', String(totalSize));
	return new Response(r2Obj.body, { status: 200, headers });
};

// Debug endpoint — visible at /tiles/_debug/cache?prefix=...&limit=...
const debugCache = async (bucket: R2Bucket, url: URL): Promise<Response> => {
	const prefix = url.searchParams.get('prefix') ?? '';
	const limit = Math.min(Number(url.searchParams.get('limit') ?? '1000'), 1000);
	const sampleSize = Math.min(Number(url.searchParams.get('sample') ?? '15'), 100);
	const startAfter = url.searchParams.get('cursor') ?? undefined;

	const listing = await bucket.list({ prefix, limit, cursor: startAfter });

	let totalBytes = 0;
	const byDomain = new Map<
		string,
		{ count: number; bytes: number; newest: string | null; oldest: string | null }
	>();
	for (const obj of listing.objects) {
		totalBytes += obj.size;
		// Keys look like: data_spatial/<domain>/<runPath>/<validTime>.om
		const parts = obj.key.split('/');
		const domain = parts[1] ?? '(unknown)';
		const uploaded = obj.uploaded.toISOString();
		const row = byDomain.get(domain) ?? { count: 0, bytes: 0, newest: null, oldest: null };
		row.count++;
		row.bytes += obj.size;
		if (!row.newest || uploaded > row.newest) row.newest = uploaded;
		if (!row.oldest || uploaded < row.oldest) row.oldest = uploaded;
		byDomain.set(domain, row);
	}

	const domains = Array.from(byDomain.entries())
		.map(([domain, row]) => ({
			domain,
			count: row.count,
			mb: +(row.bytes / 1e6).toFixed(1),
			newest: row.newest,
			oldest: row.oldest
		}))
		.sort((a, b) => b.mb - a.mb);

	const body = {
		prefix,
		count: listing.objects.length,
		totalMb: +(totalBytes / 1e6).toFixed(1),
		truncated: listing.truncated,
		cursor: listing.truncated ? (listing as { cursor?: string }).cursor ?? null : null,
		byDomain: domains,
		sample: listing.objects.slice(0, sampleSize).map((o) => ({
			key: o.key,
			mb: +(o.size / 1e6).toFixed(2),
			uploaded: o.uploaded.toISOString()
		}))
	};

	return new Response(JSON.stringify(body, null, 2), {
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			...corsHeaders
		}
	});
};

export const onRequest: PagesFunction<Env> = async (context) => {
	const { request, env } = context;

	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: corsHeaders });
	}
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
	}

	const url = new URL(request.url);
	const upstreamPath = url.pathname.replace(/^\/tiles/, '') || '/';

	// Debug endpoint.
	if (upstreamPath === '/_debug/cache' || upstreamPath === '/_debug/cache.json') {
		return debugCache(env.TILE_CACHE, url);
	}

	const upstreamUrl = `${UPSTREAM_HOST}${upstreamPath}`;
	const r2Key = upstreamPath.replace(/^\//, '');
	const ttl = pickTtl(upstreamPath);
	const forceRefresh = request.headers.get(FORCE_REFRESH_HEADER) === '1';
	const warm = request.headers.get(WARM_HEADER) === '1';
	const r2Eligible = R2_CACHEABLE(upstreamPath);

	if (forceRefresh) {
		// Evict from R2 + CF's internal cache (delete is best-effort).
		if (r2Eligible) {
			await env.TILE_CACHE.delete(r2Key).catch(() => {});
		}
		await caches.default.delete(upstreamUrl).catch(() => {});
	}

	// Warm path — fire-and-forget R2 fill, return 202 immediately. Used by
	// scripts/warm-cache.mjs so the cron fills R2 (which is global) rather than
	// per-PoP edge cache (which evicts under pressure).
	if (warm) {
		if (r2Eligible) {
			context.waitUntil(warmR2(env, r2Key, upstreamUrl));
		} else {
			// For JSON indexes, prime CF's own cache via a throwaway fetch.
			context.waitUntil(
				(async () => {
					try {
						const up = await fetch(upstreamUrl, {
							cf: {
								cacheEverything: true,
								cacheTtl: ttl
							}
						});
						if (up.body) await up.body.pipeTo(new WritableStream());
					} catch {
						/* noop */
					}
				})()
			);
		}
		return new Response(null, { status: 202, headers: corsHeaders });
	}

	const rangeHeader = request.headers.get('Range');
	const range = rangeHeader ? parseRange(rangeHeader) : null;

	// TIER 2: R2 (only for .om files).
	if (r2Eligible) {
		try {
			const r2Obj = await env.TILE_CACHE.get(
				r2Key,
				range ? { range: { offset: range.offset, length: range.length } } : undefined
			);
			if (r2Obj) {
				// R2 returns the full-object size in `.size`, regardless of range.
				return r2ToResponse(r2Obj, range, r2Obj.size, ttl);
			}
		} catch (err) {
			console.warn('[r2-get] failed', r2Key, err);
		}
	}

	// TIER 3: origin (with CF's edge cache in front via cacheEverything).
	const upstreamHeaders = new Headers();
	if (rangeHeader) upstreamHeaders.set('Range', rangeHeader);

	const fetchStart = Date.now();
	const upstream = await fetch(upstreamUrl, {
		method: request.method,
		headers: upstreamHeaders,
		cf: {
			cacheEverything: true,
			cacheTtl: ttl,
			cacheTtlByStatus: {
				'200-299': ttl,
				'404': ERROR_404_TTL,
				'500-599': 0
			}
		}
	});
	const upstreamMs = Date.now() - fetchStart;

	// If the origin response is a successful tile, kick off an R2 fill in
	// background (full file, so next user hits R2 regardless of their range).
	if (r2Eligible && upstream.ok) {
		context.waitUntil(warmR2(env, r2Key, upstreamUrl));
	}

	// Same latency heuristic as before for the CF-edge layer.
	const edgeStatus: 'HIT-EDGE' | 'MISS' | 'BYPASS' = forceRefresh
		? 'BYPASS'
		: upstreamMs < 200
			? 'HIT-EDGE'
			: 'MISS';

	const headers = new Headers(upstream.headers);
	for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
	headers.set('Cache-Control', `public, max-age=${ttl}`);
	headers.set(CACHE_STATUS_HEADER, edgeStatus);
	headers.set('X-Surfr-Upstream-Ms', String(upstreamMs));
	if (forceRefresh) headers.set('X-Surfr-Refreshed', '1');

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers
	});
};
