// Cloudflare Pages Function — wind-station file proxy (SRF-2644).
//
//   Browser ─► /stations/<file> (same-origin, no bucket URL exposed)
//              └► CF edge cache (cacheEverything, TTL per file)
//                 └► miss ─► public GCS bucket (surfrleaderboards/stations/*)
//
// Why a proxy instead of fetching storage.googleapis.com directly:
// - No GCS URL or bucket name in the client; if the bucket ever goes
//   private, auth moves HERE (Cloudflare env secret), never into the webview.
// - Same-origin → no GCS bucket CORS configuration needed.
// - Cloudflare edge caching in front of GCS: one warm URL serves everyone.
//
// The files are produced by the backend (SRF-2643):
//   live-cluster.json      nightly  — station positions + pre-clustered nodes
//   live-cluster-all.json  nightly  — + catalog-offline stations
//   readings.json          ~5 min   — live values + per-node max wind
// meta.json is server-internal and deliberately NOT proxied.

interface Env {
	// Optional override, e.g. the test bucket for preview deployments.
	STATIONS_ORIGIN?: string;
}

const DEFAULT_ORIGIN = 'https://storage.googleapis.com/surfrleaderboards/stations';

// Allowlist — this proxy serves exactly these files, nothing else.
const FILES: Record<string, { edgeTtl: number; browserCacheControl: string }> = {
	'live-cluster.json': {
		edgeTtl: 21600, // 6 h — matches the object's own max-age
		browserCacheControl: 'public, max-age=21600, stale-while-revalidate=86400'
	},
	'live-cluster-all.json': {
		edgeTtl: 21600,
		browserCacheControl: 'public, max-age=21600, stale-while-revalidate=86400'
	},
	'readings.json': {
		edgeTtl: 300, // one refresh cadence
		browserCacheControl: 'public, max-age=300, stale-while-revalidate=600'
	}
};

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': 'If-None-Match, If-Modified-Since',
	'Access-Control-Expose-Headers': 'ETag, Content-Length, X-Surfr-Upstream-Ms',
	'Access-Control-Max-Age': '3000'
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
	const file = url.pathname.replace(/^\/stations\//, '');
	const policy = FILES[file];
	if (!policy) {
		return new Response(JSON.stringify({ error: 'not-found', file }), {
			status: 404,
			headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders }
		});
	}

	const origin = (env.STATIONS_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/$/, '');
	const upstreamUrl = `${origin}/${file}`;

	// Pass conditional headers through so 304s flow end-to-end.
	const upstreamHeaders = new Headers();
	const inm = request.headers.get('If-None-Match');
	if (inm) upstreamHeaders.set('If-None-Match', inm);

	const fetchStart = Date.now();
	const upstream = await fetch(upstreamUrl, {
		method: request.method,
		headers: upstreamHeaders,
		cf: {
			cacheEverything: true,
			cacheTtl: policy.edgeTtl,
			cacheTtlByStatus: {
				'200-299': policy.edgeTtl,
				// A 404 means the backend hasn't published yet (first deploy) —
				// don't pin that state to the edge for long.
				'404': 60,
				'500-599': 0
			}
		}
	});
	const upstreamMs = Date.now() - fetchStart;

	const headers = new Headers();
	for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
	headers.set('Content-Type', 'application/json');
	headers.set('Cache-Control', policy.browserCacheControl);
	headers.set('X-Surfr-Upstream-Ms', String(upstreamMs));
	const etag = upstream.headers.get('ETag');
	if (etag) headers.set('ETag', etag);

	if (upstream.status === 304) {
		return new Response(null, { status: 304, headers });
	}
	if (!upstream.ok) {
		return new Response(
			JSON.stringify({ error: 'upstream', status: upstream.status, file }),
			{
				status: upstream.status === 404 ? 404 : 502,
				headers: { ...Object.fromEntries(headers), 'Cache-Control': 'no-store' }
			}
		);
	}

	return new Response(upstream.body, { status: 200, headers });
};
