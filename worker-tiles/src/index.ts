// Standalone tile-serving Worker. Replaces the .om-serving slice of the
// Pages Function (`functions/tiles/[[path]].ts`) so requests don't traverse
// the Pages Orange-to-Orange path — this is what lets Cache Reserve
// actually populate and serve. Admin endpoints (`_warmer-trigger`,
// `_admin`, `_debug/cache`) stay on Pages.
//
// URL shape on this Worker:
//   tiles.thesurfr.app/data_spatial/<domain>/latest.json     → R2 only
//   tiles.thesurfr.app/data_spatial/<domain>/<run>/<vt>.om   → R2 → upstream
//
// Bindings (see wrangler.toml):
//   TILE_CACHE — R2 bucket `surfr-tile-cache`.

interface Env {
	TILE_CACHE: R2Bucket;
}

const UPSTREAM_HOST = 'https://map-tiles.open-meteo.com';

const OM_FILE_TTL = 60 * 60 * 24 * 30;
const ERROR_404_TTL = 60 * 60;

const FORCE_REFRESH_HEADER = 'X-Surfr-Force-Refresh';
const CACHE_STATUS_HEADER = 'X-Surfr-Cache-Status';

const R2_OM_CACHEABLE = (path: string) => path.endsWith('.om');
const R2_JSON_KEY = (path: string): string | null => {
	if (path.endsWith('/latest.json')) return path.replace(/^\//, '');
	return null;
};

// Paths we refuse to proxy upstream. `in-progress.json` advertises a run
// upstream is still uploading; `meta.json` is upstream's per-run snapshot
// we've consolidated on `latest.json` for.
const isBlockedJson = (path: string): boolean =>
	path.endsWith('/in-progress.json') || path.endsWith('/meta.json');

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': `Range, If-Match, If-None-Match, If-Modified-Since, ${FORCE_REFRESH_HEADER}`,
	'Access-Control-Expose-Headers':
		'ETag, Content-Range, Content-Length, Accept-Ranges, X-Surfr-Cache-Status, X-Surfr-Refreshed, X-Surfr-Upstream-Ms, Age, CF-Cache-Status',
	'Access-Control-Max-Age': '3000'
};

// Parse a Range header. Returns either an absolute range (`bytes=N-M` /
// `bytes=N-`) or a suffix range (`bytes=-N` = "last N bytes"). R2's `get`
// accepts both forms, so we keep them distinct rather than resolving
// suffix→absolute up front.
type ParsedRange =
	| { kind: 'absolute'; offset: number; length: number; end: number }
	| { kind: 'suffix'; suffix: number };
const parseRange = (value: string): ParsedRange | null => {
	const trimmed = value.trim();
	const suffix = /^bytes=-(\d+)$/.exec(trimmed);
	if (suffix) {
		const n = Number(suffix[1]);
		if (!Number.isFinite(n) || n <= 0) return null;
		return { kind: 'suffix', suffix: n };
	}
	const match = /^bytes=(\d+)-(\d*)$/.exec(trimmed);
	if (!match) return null;
	const offset = Number(match[1]);
	if (!Number.isFinite(offset)) return null;
	if (match[2] === '') {
		return {
			kind: 'absolute',
			offset,
			length: Number.MAX_SAFE_INTEGER,
			end: Number.MAX_SAFE_INTEGER
		};
	}
	const end = Number(match[2]);
	if (!Number.isFinite(end) || end < offset) return null;
	return { kind: 'absolute', offset, length: end - offset + 1, end };
};

const r2ToResponse = (
	r2Obj: R2ObjectBody,
	rangeReq: ParsedRange | null,
	totalSize: number,
	cacheStatus: string
): Response => {
	const headers = new Headers();
	for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
	headers.set(
		'Content-Type',
		r2Obj.httpMetadata?.contentType ?? 'application/octet-stream'
	);
	headers.set('Cache-Control', `public, max-age=${OM_FILE_TTL}, immutable`);
	headers.set(CACHE_STATUS_HEADER, cacheStatus);
	headers.set('Accept-Ranges', 'bytes');
	if (r2Obj.httpEtag) headers.set('ETag', r2Obj.httpEtag);

	if (rangeReq) {
		let start: number;
		let end: number;
		if (rangeReq.kind === 'suffix') {
			start = Math.max(0, totalSize - rangeReq.suffix);
			end = totalSize - 1;
		} else {
			start = rangeReq.offset;
			end = Math.min(rangeReq.end, totalSize - 1);
		}
		const length = end - start + 1;
		headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
		headers.set('Content-Length', String(length));
		return new Response(r2Obj.body, { status: 206, headers });
	}

	headers.set('Content-Length', String(totalSize));
	return new Response(r2Obj.body, { status: 200, headers });
};

// Slice a cached full-object response by a requested Range. The Cache API
// stores the FULL 200 response; on a hit, we either return it as-is or
// slice it down to the requested byte range and re-package as 206. Reads
// the body fully into memory — fine for our .om files (max ~170 MB) which
// fit within Worker memory bounds.
const sliceCachedFull = async (
	cached: Response,
	range: ParsedRange | null
): Promise<Response> => {
	const totalSize = Number(cached.headers.get('Content-Length') ?? '0');
	if (!range || !cached.body || totalSize <= 0) {
		const headers = new Headers(cached.headers);
		headers.set(CACHE_STATUS_HEADER, 'HIT-EDGE');
		return new Response(cached.body, {
			status: cached.status,
			statusText: cached.statusText,
			headers
		});
	}
	let start: number;
	let end: number;
	if (range.kind === 'suffix') {
		start = Math.max(0, totalSize - range.suffix);
		end = totalSize - 1;
	} else {
		start = range.offset;
		end = Math.min(range.end, totalSize - 1);
	}
	const length = end - start + 1;
	const fullBytes = new Uint8Array(await new Response(cached.body).arrayBuffer());
	const sliced = fullBytes.subarray(start, end + 1);
	const headers = new Headers();
	for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
	headers.set('Content-Type', cached.headers.get('Content-Type') ?? 'application/octet-stream');
	headers.set('Cache-Control', cached.headers.get('Cache-Control') ?? `public, max-age=${OM_FILE_TTL}, immutable`);
	headers.set(CACHE_STATUS_HEADER, 'HIT-EDGE');
	headers.set('Accept-Ranges', 'bytes');
	const etag = cached.headers.get('ETag');
	if (etag) headers.set('ETag', etag);
	headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
	headers.set('Content-Length', String(length));
	return new Response(sliced, { status: 206, headers });
};

// Background fill: fetch full file from origin (no Range) and put into R2.
// Called via waitUntil after an R2-miss on an .om request.
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

// JSON request — serve from R2 only. If we don't have it, 503 (never origin).
// `latest.json` is a pointer to a moving target — no browser caching, so
// clients always rebuild .om URLs against the current run.
const serveJsonFromR2 = async (bucket: R2Bucket, r2Key: string): Promise<Response> => {
	const obj = await bucket.get(r2Key);
	if (!obj) {
		return new Response(
			JSON.stringify({
				error: 'cold-r2',
				message:
					'This model has not been warmed yet. Wait for the next cron tick (≤5 min) or hit /tiles/_warmer-trigger to bootstrap.',
				key: r2Key
			}),
			{
				status: 503,
				headers: {
					'Content-Type': 'application/json',
					'Retry-After': '60',
					...corsHeaders
				}
			}
		);
	}
	const headers = new Headers();
	for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
	headers.set('Content-Type', 'application/json');
	headers.set('Cache-Control', 'no-store');
	headers.set(CACHE_STATUS_HEADER, 'HIT-R2');
	if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
	headers.set('Content-Length', String(obj.size));
	return new Response(obj.body, { status: 200, headers });
};

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders });
		}
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
		}

		const url = new URL(request.url);
		const rawPath = url.pathname;

		const forceRefresh = request.headers.get(FORCE_REFRESH_HEADER) === '1';

		// JSON indexes — R2 only, never origin.
		const r2JsonKey = R2_JSON_KEY(rawPath);
		if (r2JsonKey) {
			return serveJsonFromR2(env.TILE_CACHE, r2JsonKey);
		}

		if (isBlockedJson(rawPath)) {
			return new Response(
				JSON.stringify({ error: 'blocked', message: 'use latest.json instead' }),
				{
					status: 404,
					headers: {
						'Content-Type': 'application/json',
						'Cache-Control': 'no-store',
						...corsHeaders
					}
				}
			);
		}

		// .om — client sends the canonical path including runPath.
		const upstreamUrl = `${UPSTREAM_HOST}${rawPath}`;
		const r2Key = rawPath.replace(/^\//, '');
		const r2Eligible = R2_OM_CACHEABLE(rawPath);

		// Cache key is range-stripped — we always store the FULL object
		// under the URL so a single cache entry can satisfy any range.
		const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });

		if (forceRefresh) {
			if (r2Eligible) {
				await env.TILE_CACHE.delete(r2Key).catch(() => {});
			}
			await caches.default.delete(cacheKey).catch(() => {});
			await caches.default.delete(upstreamUrl).catch(() => {});
		}

		const rangeHeader = request.headers.get('Range');
		const range = rangeHeader ? parseRange(rangeHeader) : null;

		// TIER 1: explicit Cache API check. Workers on a Custom Domain don't
		// reliably auto-cache via Cache Rules alone — empirically CF
		// bypasses the cache layer for Worker responses unless we put them
		// in via caches.default ourselves. Cache Rules + Cache Reserve
		// eligibility apply on the put, not on the response stream.
		if (r2Eligible && !forceRefresh) {
			try {
				const cached = await caches.default.match(cacheKey);
				if (cached) {
					// Slice the cached full body if a Range was requested.
					return await sliceCachedFull(cached, range);
				}
			} catch (err) {
				console.warn('[cache-match] failed', err);
			}
		}

		// TIER 2: R2.
		// Range request: read partial, return 206. Don't cache partials —
		// CR can only serve from full-object cache entries. The cron
		// rewarmer fires non-Range fetches that hit the path below and
		// populate the cache; user Range requests then hit Tier 1.
		// Non-Range request: read full, cache, return.
		if (r2Eligible) {
			try {
				if (range) {
					const r2Range =
						range.kind === 'suffix'
							? { range: { suffix: range.suffix } }
							: { range: { offset: range.offset, length: range.length } };
					const r2Obj = await env.TILE_CACHE.get(r2Key, r2Range);
					if (r2Obj) {
						return r2ToResponse(r2Obj, range, r2Obj.size, 'HIT-R2');
					}
				} else {
					const r2Obj = await env.TILE_CACHE.get(r2Key);
					if (r2Obj) {
						const fullResponse = r2ToResponse(r2Obj, null, r2Obj.size, 'HIT-R2');
						// Tee the body — one stream goes to the cache, one
						// goes to the client. Without `tee` we can only
						// consume the body once.
						if (fullResponse.body) {
							const [forCache, forClient] = fullResponse.body.tee();
							const cacheResponse = new Response(forCache, {
								status: 200,
								headers: fullResponse.headers
							});
							ctx.waitUntil(
								caches.default
									.put(cacheKey, cacheResponse)
									.catch((err) => console.warn('[cache-put] failed', err))
							);
							return new Response(forClient, {
								status: fullResponse.status,
								statusText: fullResponse.statusText,
								headers: fullResponse.headers
							});
						}
						return fullResponse;
					}
				}
			} catch (err) {
				console.warn('[r2-get] failed', r2Key, err);
			}
		}

		// TIER 3: origin (with CF's edge cache in front).
		const upstreamHeaders = new Headers();
		if (rangeHeader) upstreamHeaders.set('Range', rangeHeader);

		const fetchStart = Date.now();
		const upstream = await fetch(upstreamUrl, {
			method: request.method,
			headers: upstreamHeaders,
			cf: {
				cacheEverything: true,
				cacheTtl: OM_FILE_TTL,
				cacheTtlByStatus: {
					'200-299': OM_FILE_TTL,
					'404': ERROR_404_TTL,
					'500-599': 0
				}
			}
		});
		const upstreamMs = Date.now() - fetchStart;

		if (r2Eligible && upstream.ok) {
			ctx.waitUntil(warmR2(env, r2Key, upstreamUrl));
		}

		const originStatus: string = forceRefresh
			? 'BYPASS'
			: upstreamMs < 200
				? 'HIT-ORIGIN-EDGE'
				: 'MISS-ORIGIN';

		const headers = new Headers(upstream.headers);
		for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
		headers.set('Cache-Control', `public, max-age=${OM_FILE_TTL}, immutable`);
		headers.set(CACHE_STATUS_HEADER, originStatus);
		headers.set('X-Surfr-Upstream-Ms', String(upstreamMs));
		if (forceRefresh) headers.set('X-Surfr-Refreshed', '1');

		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers
		});
	}
};
