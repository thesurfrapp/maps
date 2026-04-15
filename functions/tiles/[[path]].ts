// Cloudflare Pages Function — tile proxy with edge caching.
//
// Forwards GET/HEAD/OPTIONS for `/tiles/<anything>` to
//   https://map-tiles.open-meteo.com/<anything>
// with `cacheEverything: true` so the first request fills the CF edge cache and
// all subsequent requests (including Range-partial reads) are served locally.
//
// Cache-lifetime model (key facts):
//   * `.om` files — immutable per `(domain, reference_time, forecast_time)`.
//     A new model run always produces new URLs; existing URLs never get
//     content updates. Safe to cache ~forever.
//   * `meta.json` — produced once per model run; immutable after publish.
//   * `latest.json` — the ONLY moving piece: its `reference_time` field flips
//     when a new model run publishes. Deliberately kept at a medium TTL so
//     clients lag behind the warmer — i.e. we want clients to still be reading
//     the old reference_time while the warmer discovers and pre-warms the new
//     run's URLs. Force-refresh (X-Surfr-Force-Refresh: 1) lets the warmer
//     evict `latest.json` atomically after warming completes.

const UPSTREAM_HOST = 'https://map-tiles.open-meteo.com';

// TTLs in seconds.
const OM_FILE_TTL = 60 * 60 * 24 * 30; // 30 days — URLs are immutable, cache as long as CF keeps it.
const META_JSON_TTL = 60 * 60 * 24 * 30; // 30 days — per-run metadata, immutable.
const LATEST_JSON_TTL = 60 * 5; // 5 min — long enough that clients lag the warmer.
const IN_PROGRESS_JSON_TTL = 30; // 30 s — reflects a run still being written.
// 404s on .om URLs mean "this forecast hour is beyond this run's horizon".
// The horizon doesn't change within a run, so we can safely cache the 404 for
// as long as the run itself lives. Keeps repeated out-of-horizon probes fast
// even though RN should already be gating them via useMapValidTimes.
const ERROR_404_TTL = 60 * 60; // 1 hour

const FORCE_REFRESH_HEADER = 'X-Surfr-Force-Refresh';
// Fire-and-forget cache warming. When set on a request, the proxy kicks off
// the upstream fetch with cacheEverything + drain-via-waitUntil, and returns
// 202 immediately so the caller (our warmer) doesn't need to hold a
// potentially multi-hundred-MB stream open. CF continues the cache fill in
// the background.
const WARM_HEADER = 'X-Surfr-Warm';

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': `Range, If-Match, If-None-Match, If-Modified-Since, ${FORCE_REFRESH_HEADER}, ${WARM_HEADER}`,
	'Access-Control-Expose-Headers': 'ETag, Content-Range, Content-Length, Accept-Ranges',
	'Access-Control-Max-Age': '3000'
};

// Pick the TTL for a given upstream path. The path shape is:
//   /data_spatial/{domain}/{YYYY}/{MM}/{DD}/{HHmm}Z/{forecastTime}.om
//   /data_spatial/{domain}/latest.json
//   /data_spatial/{domain}/in-progress.json
//   /data_spatial/{domain}/{YYYY}/{MM}/{DD}/{HHmm}Z/meta.json
const pickTtl = (path: string): number => {
	if (path.endsWith('.om')) return OM_FILE_TTL;
	if (path.endsWith('/latest.json')) return LATEST_JSON_TTL;
	if (path.endsWith('/in-progress.json')) return IN_PROGRESS_JSON_TTL;
	if (path.endsWith('/meta.json')) return META_JSON_TTL;
	// Unknown .json or asset — short but non-zero.
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
	// Strip query params when talking to upstream/CF cache. `.om` URLs append
	// `?variable=wind_speed_10m` (and similar) purely as client-side metadata
	// — the .om binary contains every variable and S3 ignores the query.
	// Without stripping, every variable-flavour hits a different CF cache
	// entry, so our warmer (which omits the query) never covers the library's
	// real fetches. Converging on a single no-query cache key makes warmer and
	// library share the same edge entry.
	const upstreamUrl = `${UPSTREAM_HOST}${upstreamPath}`;

	const ttl = pickTtl(upstreamPath);
	const forceRefresh = request.headers.get(FORCE_REFRESH_HEADER) === '1';
	const warm = request.headers.get(WARM_HEADER) === '1';

	// Fire-and-forget warming path. The warmer calls us with this header to
	// prime CF's edge cache without having to stream the full upstream body.
	// We kick off the fetch + drain via waitUntil and return immediately.
	if (warm) {
		const cachePromise = (async () => {
			try {
				if (forceRefresh) {
					await caches.default.delete(upstreamUrl).catch(() => {});
				}
				const up = await fetch(upstreamUrl, {
					cf: {
						cacheEverything: true,
						cacheTtl: ttl,
						cacheTtlByStatus: { '200-299': ttl, '404': ERROR_404_TTL, '500-599': 0 }
					}
				});
				// Must drain the body for CF to finish populating the cache entry.
				if (up.body) await up.body.pipeTo(new WritableStream());
			} catch {
				/* noop */
			}
		})();
		context.waitUntil(cachePromise);
		return new Response(null, { status: 202, headers: corsHeaders });
	}

	// Forward relevant headers only. Range is critical (the Open-Meteo client
	// does byte-range reads into large .om files).
	const upstreamHeaders = new Headers();
	const range = request.headers.get('Range');
	if (range) upstreamHeaders.set('Range', range);
	const ifNoneMatch = request.headers.get('If-None-Match');
	if (ifNoneMatch) upstreamHeaders.set('If-None-Match', ifNoneMatch);
	const ifModifiedSince = request.headers.get('If-Modified-Since');
	if (ifModifiedSince) upstreamHeaders.set('If-Modified-Since', ifModifiedSince);

	// Force-refresh path: evict the existing edge entry *before* the fetch. The
	// fetch below uses `cacheEverything: true` which — after our delete — will
	// miss, pull fresh from origin, and repopulate the edge cache automatically.
	// This handles both 200 (full) and 206 (Range) responses correctly; CF stores
	// the full resource internally and serves arbitrary ranges out of it.
	// Primary use: the warmer invalidates `latest.json` after pre-warming the new
	// run's .om files, so clients never see a reference_time that isn't backed
	// by warm .om entries.
	if (forceRefresh) {
		await caches.default.delete(upstreamUrl).catch(() => {});
	}

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

	const headers = new Headers(upstream.headers);
	for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
	headers.set('Cache-Control', `public, max-age=${ttl}`);
	if (forceRefresh) {
		headers.set('X-Surfr-Refreshed', '1');
	}

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers
	});
};
