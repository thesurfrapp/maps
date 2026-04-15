// Cloudflare Pages Function — tile proxy with edge caching.
//
// Forwards GET/HEAD/OPTIONS for `/tiles/<anything>` to
//   https://map-tiles.open-meteo.com/<anything>
// with `cacheEverything` + 60 min TTL so the first request fills the CF edge
// cache and all subsequent requests (including Range-partial ones) are served
// locally. Also takes load off Open-Meteo.
//
// Open-Meteo rewrites the same URL when a new model run publishes (every 3–6 h
// per domain). To stay fresh we combine TTL with a **force-refresh** mode:
// a warmer cron sends `X-Surfr-Force-Refresh: 1` every 6 h to evict + repopulate
// the edge cache. Per-URL precision, no CF zone-purge API used.

const UPSTREAM_HOST = 'https://map-tiles.open-meteo.com';

// TTLs in seconds
const OM_FILE_TTL = 60 * 60; // 60 minutes — bounded staleness between force-refreshes
const JSON_INDEX_TTL = 60; // 1 minute — fresh model-run metadata
const ERROR_404_TTL = 30;

const FORCE_REFRESH_HEADER = 'X-Surfr-Force-Refresh';

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': `Range, If-Match, If-None-Match, If-Modified-Since, ${FORCE_REFRESH_HEADER}`,
	'Access-Control-Expose-Headers': 'ETag, Content-Range, Content-Length, Accept-Ranges',
	'Access-Control-Max-Age': '3000'
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
	const upstreamUrl = `${UPSTREAM_HOST}${upstreamPath}${url.search}`;

	const isOmFile = upstreamPath.endsWith('.om');
	const ttl = isOmFile ? OM_FILE_TTL : JSON_INDEX_TTL;
	const forceRefresh = request.headers.get(FORCE_REFRESH_HEADER) === '1';

	// Forward relevant headers only (Range is the big one — the Open-Meteo library
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
	if (forceRefresh) {
		await caches.default.delete(upstreamUrl).catch(() => {});
	}

	// Single fetch init — always use cacheEverything so CF's edge cache stays
	// the source of truth. When the warmer force-refreshes, the above delete
	// guarantees this fetch misses and repopulates with fresh data.
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

	// Mirror upstream response with CORS tacked on.
	const headers = new Headers(upstream.headers);
	for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
	// Advertise our own Cache-Control so browsers cache the proxy response too.
	headers.set('Cache-Control', `public, max-age=${ttl}`);
	if (forceRefresh) {
		// Signal back to the warmer that this request went through the refresh path.
		headers.set('X-Surfr-Refreshed', '1');
	}

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers
	});
};
