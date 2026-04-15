// Cloudflare Pages Function — tile proxy with edge caching.
//
// Forwards GET/HEAD/OPTIONS for `/tiles/<anything>` to
//   https://map-tiles.open-meteo.com/<anything>
// with `cacheEverything` + short TTL so the first request fills the CF edge cache
// and all subsequent requests (including Range-partial ones) are served locally.
// Also takes load off Open-Meteo.
//
// Keep TTLs short — Open-Meteo re-publishes / corrects .om tiles during a model
// run; 20 min balances "fresh enough" with "one user session stays on cache".

const UPSTREAM_HOST = 'https://map-tiles.open-meteo.com';

// TTLs in seconds
const OM_FILE_TTL = 60 * 20; // 20 minutes
const JSON_INDEX_TTL = 60; // 1 minute — fresh model-run metadata
const ERROR_404_TTL = 30;

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': 'Range, If-Match, If-None-Match, If-Modified-Since',
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

	// Forward relevant headers only (Range is the big one — the Open-Meteo library
	// does byte-range reads into large .om files).
	const upstreamHeaders = new Headers();
	const range = request.headers.get('Range');
	if (range) upstreamHeaders.set('Range', range);
	const ifNoneMatch = request.headers.get('If-None-Match');
	if (ifNoneMatch) upstreamHeaders.set('If-None-Match', ifNoneMatch);
	const ifModifiedSince = request.headers.get('If-Modified-Since');
	if (ifModifiedSince) upstreamHeaders.set('If-Modified-Since', ifModifiedSince);

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

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers
	});
};
