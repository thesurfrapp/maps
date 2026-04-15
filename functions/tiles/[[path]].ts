// Cloudflare Pages Function — tile proxy with **explicit** Cache API caching.
//
// Forwards GET/HEAD/OPTIONS for `/tiles/<anything>` to
//   https://map-tiles.open-meteo.com/<anything>
//
// Why explicit Cache API instead of `cf.cacheEverything: true`:
//   * `cf.cacheEverything` works but uses an opaque internal cache key that
//     `caches.default.match()` cannot peek at. We can never know HIT/MISS from
//     within the Worker.
//   * Managing the cache ourselves with `caches.default.{match,put,delete}`
//     gives us a single, deterministic cache key (the upstream URL) and means
//     `match()` actually returns what we stored. Reliable HIT/MISS visibility.
//
// Cache-lifetime model:
//   * `.om` files — immutable per (domain, reference_time, forecast_time).
//     Cache 30 days.
//   * `meta.json` — per-run, immutable after publish. Cache 30 days.
//   * `latest.json` — flips when a new model run publishes. 5 min so clients
//     lag the warmer (warmer warms new run, then explicitly refreshes
//     latest.json via X-Surfr-Force-Refresh).
//   * `in-progress.json` — short TTL (30s) to track a writing run.
//   * 404s — 1 hour (horizon doesn't change within a run).
//
// Range handling:
//   * We fetch the FULL response from upstream (no Range header) when caching.
//     CF's edge cache stores the complete 200 response.
//   * Client Range requests get sliced from the cached full body. This is what
//     makes warmer-time investment pay off — one cache fill serves any range.

const UPSTREAM_HOST = 'https://map-tiles.open-meteo.com';

const OM_FILE_TTL = 60 * 60 * 24 * 30;
const META_JSON_TTL = 60 * 60 * 24 * 30;
const LATEST_JSON_TTL = 60 * 5;
const IN_PROGRESS_JSON_TTL = 30;
const ERROR_404_TTL = 60 * 60;

const FORCE_REFRESH_HEADER = 'X-Surfr-Force-Refresh';
const WARM_HEADER = 'X-Surfr-Warm';

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

// Parse a `Range: bytes=A-B` header into [start, end] inclusive. Returns null
// if no range or invalid.
function parseRange(header: string | null, totalSize: number): [number, number] | null {
	if (!header) return null;
	const m = /^bytes=(\d+)-(\d*)$/.exec(header);
	if (!m) return null;
	const start = Number(m[1]);
	const end = m[2] ? Number(m[2]) : totalSize - 1;
	if (Number.isNaN(start) || Number.isNaN(end) || start > end) return null;
	return [Math.max(0, start), Math.min(end, totalSize - 1)];
}

// Fetch the full upstream response (no Range header) so the cache stores the
// complete file. Future Range requests slice from this.
async function fetchUpstreamFull(upstreamUrl: string): Promise<Response> {
	return fetch(upstreamUrl);
}

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
	// Strip query params — `.om` URLs append `?variable=...` purely as
	// client-side metadata. The .om binary contains every variable, S3 ignores
	// the query, and stripping converges all variants on one cache key so the
	// warmer's URL matches what the library fetches.
	const upstreamUrl = `${UPSTREAM_HOST}${upstreamPath}`;

	const ttl = pickTtl(upstreamPath);
	const forceRefresh = request.headers.get(FORCE_REFRESH_HEADER) === '1';
	const warm = request.headers.get(WARM_HEADER) === '1';

	// Cache key — same shape regardless of Range header so we always hit the
	// full cached entry and slice as needed.
	const cacheKey = new Request(upstreamUrl, { method: 'GET' });
	const cache = caches.default;

	// ──── Force-refresh path ────────────────────────────────────────────────
	if (forceRefresh) {
		await cache.delete(cacheKey).catch(() => {});
	}

	// ──── Fire-and-forget warming path ──────────────────────────────────────
	// Warmer sends X-Surfr-Warm: 1 + no Range. We fetch full upstream + put
	// in cache via waitUntil and return 202 immediately so the warmer doesn't
	// hold the connection.
	if (warm) {
		context.waitUntil(
			(async () => {
				try {
					const up = await fetchUpstreamFull(upstreamUrl);
					if (!up.ok && up.status !== 404) return;
					const cached = new Response(up.body, {
						status: up.status,
						headers: { 'Cache-Control': `public, max-age=${ttl}` }
					});
					await cache.put(cacheKey, cached);
				} catch {
					/* noop */
				}
			})()
		);
		return new Response(null, { status: 202, headers: corsHeaders });
	}

	// ──── Normal client request path ───────────────────────────────────────
	let cacheStatus: 'HIT' | 'MISS' = 'MISS';
	let cached = await cache.match(cacheKey).catch(() => null);

	if (!cached) {
		// Miss → fetch full from upstream, store in cache, then serve.
		const up = await fetchUpstreamFull(upstreamUrl);
		// Build a cacheable response: keep status + body, set our Cache-Control.
		const headers = new Headers();
		headers.set('Cache-Control', `public, max-age=${up.status === 404 ? ERROR_404_TTL : ttl}`);
		// Preserve a few useful upstream headers
		const ct = up.headers.get('content-type');
		if (ct) headers.set('Content-Type', ct);
		const etag = up.headers.get('etag');
		if (etag) headers.set('ETag', etag);
		const lm = up.headers.get('last-modified');
		if (lm) headers.set('Last-Modified', lm);

		// Read the full body so we can store and slice. For .om files this is
		// 30-200 MB — fine in Worker memory for one request, freed after.
		const buf = await up.arrayBuffer();
		const toCache = new Response(buf, { status: up.status, headers });
		// waitUntil so cache write doesn't delay the user response.
		context.waitUntil(cache.put(cacheKey, toCache.clone()).catch(() => {}));
		cached = toCache;
	} else {
		cacheStatus = 'HIT';
	}

	// Build the outgoing response. Honor Range if the client asked for one
	// AND the cached entry is a full 200.
	const outHeaders = new Headers();
	for (const [k, v] of Object.entries(corsHeaders)) outHeaders.set(k, v);
	outHeaders.set('Cache-Control', `public, max-age=${ttl}`);
	outHeaders.set('X-Surfr-Cache-Status', forceRefresh ? 'BYPASS' : cacheStatus);
	if (forceRefresh) outHeaders.set('X-Surfr-Refreshed', '1');
	const ct = cached.headers.get('content-type');
	if (ct) outHeaders.set('Content-Type', ct);

	const rangeHeader = request.headers.get('Range');
	if (rangeHeader && cached.status === 200) {
		const buf = await cached.arrayBuffer();
		const range = parseRange(rangeHeader, buf.byteLength);
		if (range) {
			const [start, end] = range;
			const slice = buf.slice(start, end + 1);
			outHeaders.set('Content-Range', `bytes ${start}-${end}/${buf.byteLength}`);
			outHeaders.set('Content-Length', String(end - start + 1));
			outHeaders.set('Accept-Ranges', 'bytes');
			return new Response(slice, { status: 206, statusText: 'Partial Content', headers: outHeaders });
		}
	}

	// HEAD: no body, full headers (with content-length from cached body).
	if (request.method === 'HEAD') {
		const buf = await cached.arrayBuffer();
		outHeaders.set('Content-Length', String(buf.byteLength));
		outHeaders.set('Accept-Ranges', 'bytes');
		return new Response(null, { status: cached.status, headers: outHeaders });
	}

	// Non-range GET: clone body so we can return it.
	return new Response(cached.body, { status: cached.status, headers: outHeaders });
};
