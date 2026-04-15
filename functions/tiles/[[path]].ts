// Cloudflare Pages Function — tile proxy with edge caching.
//
// Forwards GET/HEAD/OPTIONS for `/tiles/<anything>` to
//   https://map-tiles.open-meteo.com/<anything>
// using `cf.cacheEverything: true` so CF caches automatically and handles
// Range requests natively (sliced from the cached full response).
//
// HIT/MISS visibility:
//   We can't reliably read CF's internal cache state from a Worker
//   (cf-cache-status comes back DYNAMIC for Worker responses, and
//   `caches.default.match()` uses a different cache key than cacheEverything).
//   Instead we infer from upstream fetch latency: a fetch that returns in
//   <200 ms is almost certainly served from CF's edge cache (it would be
//   100-2000 ms from upstream Open-Meteo). The X-Surfr-Cache-Status header
//   reflects that heuristic.
//
// Cache-lifetime model:
//   * `.om` files       — immutable per (domain, ref_time, forecast_time). 30 days.
//   * `meta.json`       — per-run, immutable. 30 days.
//   * `latest.json`     — flips on new run publish. 5 min so clients lag warmer.
//   * `in-progress.json`— writing run. 30 s.
//   * 404s — 1 hour (horizon doesn't change within a run).

const UPSTREAM_HOST = 'https://map-tiles.open-meteo.com';

const OM_FILE_TTL = 60 * 60 * 24 * 30;
const META_JSON_TTL = 60 * 60 * 24 * 30;
const LATEST_JSON_TTL = 60 * 5;
const IN_PROGRESS_JSON_TTL = 30;
const ERROR_404_TTL = 60 * 60;

const FORCE_REFRESH_HEADER = 'X-Surfr-Force-Refresh';
const WARM_HEADER = 'X-Surfr-Warm';

// Latency below this = strong indicator of a CF edge cache hit. Above 200ms
// usually means upstream was contacted (cold edge or origin pull).
const CACHE_HIT_LATENCY_MS = 200;

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': `Range, If-Match, If-None-Match, If-Modified-Since, ${FORCE_REFRESH_HEADER}, ${WARM_HEADER}`,
	'Access-Control-Expose-Headers':
		'ETag, Content-Range, Content-Length, Accept-Ranges, X-Surfr-Cache-Status, X-Surfr-Refreshed',
	'Access-Control-Max-Age': '3000'
};

const pickTtl = (path: string): number => {
	if (path.endsWith('.om')) return OM_FILE_TTL;
	if (path.endsWith('/latest.json')) return LATEST_JSON_TTL;
	if (path.endsWith('/in-progress.json')) return IN_PROGRESS_JSON_TTL;
	if (path.endsWith('/meta.json')) return META_JSON_TTL;
	return LATEST_JSON_TTL;
};

export const onRequest: PagesFunction = async (context) => {
	const { request } = context;

	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: corsHeaders });
	}
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
	}

	const url = new URL(request.url);
	const upstreamPath = url.pathname.replace(/^\/tiles/, '') || '/';
	// Strip query — `?variable=...` is client-side metadata, S3 ignores it.
	// Stripping makes warmer URLs and library URLs converge on one cache key.
	const upstreamUrl = `${UPSTREAM_HOST}${upstreamPath}`;

	const ttl = pickTtl(upstreamPath);
	const forceRefresh = request.headers.get(FORCE_REFRESH_HEADER) === '1';
	const warm = request.headers.get(WARM_HEADER) === '1';

	if (forceRefresh) {
		// Evict from BOTH cache layers. cf.cacheEverything's internal cache and
		// caches.default share the same physical store but use different keys
		// for lookup. delete() with a URL-only key clears at least one path.
		await caches.default.delete(upstreamUrl).catch(() => {});
	}

	// Fire-and-forget warming. Warmer fetches without Range; we kick off the
	// upstream fetch + cache-fill via waitUntil and return 202 immediately.
	if (warm) {
		context.waitUntil(
			(async () => {
				try {
					const up = await fetch(upstreamUrl, {
						cf: {
							cacheEverything: true,
							cacheTtl: ttl,
							cacheTtlByStatus: { '200-299': ttl, '404': ERROR_404_TTL, '500-599': 0 }
						}
					});
					// Drain so CF finishes populating the cache entry.
					if (up.body) await up.body.pipeTo(new WritableStream());
				} catch {
					/* noop */
				}
			})()
		);
		return new Response(null, { status: 202, headers: corsHeaders });
	}

	// Normal client request — forward Range etc. and rely on cf.cacheEverything.
	const upstreamHeaders = new Headers();
	const range = request.headers.get('Range');
	if (range) upstreamHeaders.set('Range', range);
	const ifNoneMatch = request.headers.get('If-None-Match');
	if (ifNoneMatch) upstreamHeaders.set('If-None-Match', ifNoneMatch);
	const ifModifiedSince = request.headers.get('If-Modified-Since');
	if (ifModifiedSince) upstreamHeaders.set('If-Modified-Since', ifModifiedSince);

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

	// Heuristic HIT/MISS based on upstream fetch latency. Edge cache hits are
	// near-instant (<200 ms TTFB even for byte-range requests); origin pulls
	// take 100-2000 ms. Not perfect but the best signal a Worker can derive.
	const cacheStatus: 'HIT' | 'MISS' | 'BYPASS' = forceRefresh
		? 'BYPASS'
		: upstreamMs < CACHE_HIT_LATENCY_MS
			? 'HIT'
			: 'MISS';

	const headers = new Headers(upstream.headers);
	for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
	headers.set('Cache-Control', `public, max-age=${ttl}`);
	headers.set('X-Surfr-Cache-Status', cacheStatus);
	headers.set('X-Surfr-Upstream-Ms', String(upstreamMs));
	if (forceRefresh) headers.set('X-Surfr-Refreshed', '1');

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers
	});
};
