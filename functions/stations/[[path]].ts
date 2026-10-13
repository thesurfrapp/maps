// Cloudflare Pages Function — wind-station file proxy (SRF-2644, source moved in SRF-2994).
//
//   Browser ─► /stations/<file> (same-origin)
//              └► Cache API (this PoP, TTL per file)
//                 └► miss ─► live-wind service /v1/stations/layer/<name> (+ source token)
//
// The files come from the Cloudflare live-wind service (surfr-live-wind), built from
// its snapshot plus the push hot lane — the only source of live wind for the app
// (ADR-036). Until SRF-2994 they came from a public GCS bucket the classic backend
// wrote from Postgres.
//
//   live-cluster.json  — station positions + pre-grouped bubbles; changes only when
//                        stations are added/removed (its `v`)
//   readings.json      — live values + per-bubble max wind
//
// Why a proxy:
// - The live-wind source token stays here (Pages secret STATIONS_TOKEN), never in the
//   webview.
// - Same-origin → no CORS setup on the live-wind service.
// - One warm copy per PoP serves every viewer, so the service sees a request per PoP
//   per TTL, not one per open map.
//
// Caching is explicit (Cache API), not `cf.cacheEverything`: the upstream request carries
// an Authorization header, and Cloudflare's fetch cache does not reliably store those.
//
// Needs `global_fetch_strictly_public` (wrangler.toml): the live-wind service runs on our
// own zone, and without the flag a fetch to it would skip the Worker on its route.

interface Env {
	// Override for preview deployments, e.g. https://test-live-wind.thesurfr.app/v1/stations/layer
	STATIONS_ORIGIN?: string;
	// Live-wind source token (an entry in the service's SOURCE_TOKENS_JSON).
	STATIONS_TOKEN?: string;
}

const DEFAULT_ORIGIN = 'https://live-wind.thesurfr.app/v1/stations/layer';

// Allowlist — this proxy serves exactly these files, nothing else.
const FILES: Record<string, { upstream: string; edgeTtl: number; browserCacheControl: string }> = {
	'live-cluster.json': {
		upstream: 'live-cluster',
		// Long on purpose: a changed station set is caught by the readings `v` guard,
		// which force-refreshes this file (and the PoP copy with it).
		edgeTtl: 21600,
		browserCacheControl: 'public, max-age=21600, stale-while-revalidate=86400'
	},
	'readings.json': {
		upstream: 'readings',
		edgeTtl: 60, // push stations are seconds-fresh upstream; keep the PoP copy short
		browserCacheControl: 'public, max-age=60, stale-while-revalidate=300'
	}
};

// Client sends this on a version-guard reload (base/readings v mismatch) so a stale
// PoP copy can't outlive a station-set change — same mechanism as the tiles proxy.
const FORCE_REFRESH_HEADER = 'X-Surfr-Force-Refresh';
// Anyone can send that header, and every upstream call spends the shared `maps` token's
// rate limit. So a forced refresh only refetches when the PoP copy is older than this:
// upstream load stays bounded per PoP however often the header arrives.
const FORCE_REFRESH_MIN_AGE_MS = 30_000;
const CACHED_AT_HEADER = 'X-Surfr-Cached-At';

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': `If-None-Match, If-Modified-Since, ${FORCE_REFRESH_HEADER}`,
	'Access-Control-Expose-Headers': 'ETag, Content-Length, X-Surfr-Upstream-Ms',
	'Access-Control-Max-Age': '3000'
};

const errorResponse = (status: number, body: Record<string, unknown>): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders }
	});

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
	if (!policy) return errorResponse(404, { error: 'not-found', file });
	if (!env.STATIONS_TOKEN) return errorResponse(503, { error: 'not-configured', file });

	const origin = (env.STATIONS_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/$/, '');
	const upstreamUrl = `${origin}/${policy.upstream}`;
	// Cache key carries no credentials: one shared copy per PoP for every viewer.
	const cacheKey = new Request(upstreamUrl, { method: 'GET' });
	const cache = caches.default;
	const forceRefresh = request.headers.get(FORCE_REFRESH_HEADER) === '1';

	let body: Response | undefined = await cache.match(cacheKey);
	if (body && forceRefresh) {
		const cachedAt = Number(body.headers.get(CACHED_AT_HEADER) ?? 0);
		if (Date.now() - cachedAt >= FORCE_REFRESH_MIN_AGE_MS) body = undefined;
	}
	let upstreamMs = 0;
	if (!body) {
		const fetchStart = Date.now();
		const upstream = await fetch(upstreamUrl, {
			headers: { Authorization: `Bearer ${env.STATIONS_TOKEN}` }
		});
		upstreamMs = Date.now() - fetchStart;
		if (!upstream.ok) {
			return errorResponse(upstream.status === 404 ? 404 : 502, {
				error: 'upstream',
				status: upstream.status,
				file
			});
		}
		const toCache = new Response(upstream.body, {
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': `public, s-maxage=${policy.edgeTtl}`,
				[CACHED_AT_HEADER]: String(Date.now()),
				...(upstream.headers.get('ETag') ? { ETag: upstream.headers.get('ETag')! } : {})
			}
		});
		context.waitUntil(cache.put(cacheKey, toCache.clone()));
		body = toCache;
	}

	const headers = new Headers();
	for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
	headers.set('Content-Type', 'application/json');
	headers.set('Cache-Control', policy.browserCacheControl);
	headers.set('X-Surfr-Upstream-Ms', String(upstreamMs));
	const etag = body.headers.get('ETag');
	if (etag) {
		headers.set('ETag', etag);
		if (request.headers.get('If-None-Match') === etag) {
			return new Response(null, { status: 304, headers });
		}
	}
	return new Response(request.method === 'HEAD' ? null : body.body, { status: 200, headers });
};
