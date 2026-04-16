// Cloudflare Pages Function — tile proxy backed by R2.
//
//   Browser ─► CF edge cache (auto-populated from our Cache-Control headers)
//              └► miss ─► this Function runs
//                         ├► For `.om`  : rewrite run-path to our R2 latest.json
//                         │               then serve from R2 (HIT-R2) or origin (MISS).
//                         ├► For json   : serve from R2 *only* — 503 if missing.
//                         │               No origin fallback, since origin could
//                         │               advertise a run the cron hasn't warmed.
//                         └► Debug      : /tiles/_debug/cache — JSON inventory.
//
// Bindings (configured in the Pages project dashboard):
//   TILE_CACHE — R2 bucket. See Pages project → Settings → Functions → R2 bindings.

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

const R2_OM_CACHEABLE = (path: string) => path.endsWith('.om');
const R2_JSON_KEY = (path: string): string | null => {
	// Only `latest.json` and `meta.json` are R2-canonical. `in-progress.json`
	// falls through to origin (transient state, not worth persisting).
	if (path.endsWith('/latest.json')) return path.replace(/^\//, '');
	if (path.endsWith('/meta.json')) return path.replace(/^\//, '');
	return null;
};

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
		return { offset, length: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER };
	}
	const end = Number(match[2]);
	if (!Number.isFinite(end) || end < offset) return null;
	return { offset, length: end - offset + 1, end };
};

// Build a Response from an R2 object body. Handles Range (206) vs full (200).
const r2ToResponse = (
	r2Obj: R2ObjectBody,
	rangeReq: { offset: number; end: number } | null,
	totalSize: number,
	ttl: number,
	cacheStatus: string
): Response => {
	const headers = new Headers();
	for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
	headers.set(
		'Content-Type',
		r2Obj.httpMetadata?.contentType ?? 'application/octet-stream'
	);
	headers.set('Cache-Control', `public, max-age=${ttl}`);
	headers.set(CACHE_STATUS_HEADER, cacheStatus);
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

// Read our canonical latest.json from R2 for a given domain. Returns null if
// the cron hasn't populated it yet.
const readR2Latest = async (
	bucket: R2Bucket,
	domain: string
): Promise<{ reference_time: string } | null> => {
	try {
		const obj = await bucket.get(`data_spatial/${domain}/latest.json`);
		if (!obj) return null;
		const parsed = JSON.parse(await obj.text()) as { reference_time?: string };
		return parsed.reference_time ? { reference_time: parsed.reference_time } : null;
	} catch {
		return null;
	}
};

// Module-level in-memory cache so we don't R2-read latest.json on every `.om`
// request. Each Pages Function isolate gets its own map; isolates are
// ephemeral (CF evicts them aperiodically) so staleness is bounded by both the
// TTL *and* isolate lifetime. Staleness window (30s) is tiny relative to the
// 1–12 h cadence at which new runs publish — briefly serving a just-past-run
// latest.json is harmless since its .om files are still in R2 (we only delete
// them AFTER swapping latest.json).
const LATEST_MEM_CACHE_TTL_MS = 30_000;
const latestMemCache = new Map<
	string,
	{ value: { reference_time: string } | null; cachedAt: number }
>();

const readR2LatestCached = async (
	bucket: R2Bucket,
	domain: string
): Promise<{ reference_time: string } | null> => {
	const hit = latestMemCache.get(domain);
	if (hit && Date.now() - hit.cachedAt < LATEST_MEM_CACHE_TTL_MS) {
		return hit.value;
	}
	const fresh = await readR2Latest(bucket, domain);
	latestMemCache.set(domain, { value: fresh, cachedAt: Date.now() });
	return fresh;
};

// Format an ISO UTC reference time → "YYYY/MM/DD/HHmmZ" run-path segment.
const fmtRunPath = (isoRefTime: string): string => {
	const d = new Date(isoRefTime);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
};

// Parse the client's stripped .om path. Client sends:
//   /data_spatial/<domain>/<validTime>.om
// We fill in the runPath from R2 latest.json to construct the canonical path:
//   /data_spatial/<domain>/<YYYY>/<MM>/<DD>/<HHmm>Z/<validTime>.om
// The client never knows which run it's getting — R2 is the single source of truth.
const buildCanonicalOmPath = (
	requestedPath: string,
	currentReferenceTime: string
): { path: string; domain: string | null } | null => {
	// Stripped shape: ['', 'data_spatial', domain, '<validTime>.om']  (4 segments)
	// Legacy full shape: ['', 'data_spatial', domain, YYYY, MM, DD, HHmmZ, '<validTime>.om']  (8 segments)
	const segments = requestedPath.split('/');
	if (segments[1] !== 'data_spatial') return null;
	const last = segments[segments.length - 1];
	if (!last.endsWith('.om')) return null;

	if (segments.length === 4) {
		// Client sent stripped path — fill in canonical runPath.
		const domain = segments[2];
		return {
			path: `/data_spatial/${domain}/${fmtRunPath(currentReferenceTime)}/${last}`,
			domain
		};
	}

	if (segments.length === 8) {
		// Legacy full path — replace runPath with current. Keeps working with any
		// old deployed clients during the transition.
		const domain = segments[2];
		return {
			path: `/data_spatial/${domain}/${fmtRunPath(currentReferenceTime)}/${last}`,
			domain
		};
	}

	return null; // unrecognised shape
};

// Extract domain from any structured tile path that starts `/data_spatial/<domain>/...`
const extractDomain = (path: string): string | null => {
	const m = /^\/data_spatial\/([^/]+)(\/|$)/.exec(path);
	return m ? m[1] : null;
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

// Debug endpoint — /tiles/_debug/cache?prefix=...&limit=...
const debugCache = async (bucket: R2Bucket, url: URL): Promise<Response> => {
	const prefix = url.searchParams.get('prefix') ?? '';
	const limit = Math.min(Number(url.searchParams.get('limit') ?? '1000'), 1000);
	const sampleSize = Math.min(Number(url.searchParams.get('sample') ?? '15'), 100);
	const startAfter = url.searchParams.get('cursor') ?? undefined;

	const listing = await bucket.list({ prefix, limit, cursor: startAfter });

	// Read warmer's last-run record (written by the cron on every tick) so
	// the inventory also tells you when the warmer actually ran.
	let lastCron: unknown = null;
	try {
		const lr = await bucket.get('_warmer/last-run.json');
		if (lr) lastCron = JSON.parse(await lr.text());
	} catch {
		/* noop */
	}

	let totalBytes = 0;
	const byDomain = new Map<
		string,
		{ count: number; bytes: number; newest: string | null; oldest: string | null }
	>();
	for (const obj of listing.objects) {
		totalBytes += obj.size;
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
		generatedAt: new Date().toISOString(),
		lastCron,
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

// JSON request — serve from R2 only. If we don't have it, 503 (never origin).
// This guarantees clients only see runs the warmer has finished filling.
const serveJsonFromR2 = async (
	bucket: R2Bucket,
	r2Key: string,
	ttl: number
): Promise<Response> => {
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
	headers.set('Cache-Control', `public, max-age=${ttl}`);
	headers.set(CACHE_STATUS_HEADER, 'HIT-R2');
	if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
	headers.set('Content-Length', String(obj.size));
	return new Response(obj.body, { status: 200, headers });
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
	const rawPath = url.pathname.replace(/^\/tiles/, '') || '/';

	// Debug endpoint.
	if (rawPath === '/_debug/cache' || rawPath === '/_debug/cache.json') {
		return debugCache(env.TILE_CACHE, url);
	}

	const forceRefresh = request.headers.get(FORCE_REFRESH_HEADER) === '1';
	const warm = request.headers.get(WARM_HEADER) === '1';

	// ── JSON indexes: R2 only, never origin. ─────────────────────────────────
	const r2JsonKey = R2_JSON_KEY(rawPath);
	if (r2JsonKey) {
		// `latest.json` and `meta.json` are written exclusively by the warmer.
		// Force-refresh is meaningless here (the warmer owns their lifecycle) —
		// ignore the header.
		const ttl = pickTtl(rawPath);
		return serveJsonFromR2(env.TILE_CACHE, r2JsonKey, ttl);
	}

	// ── .om — construct canonical path from R2 latest.json. ─────────────────
	// Client sends either stripped (`/data_spatial/<d>/<validTime>.om`) or
	// legacy full (`/data_spatial/<d>/<runPath>/<validTime>.om`) — we read R2
	// latest.json for the domain and always build the canonical path from it.
	let upstreamPath = rawPath;
	let referenceTime: string | null = null;
	let latestMs = 0;
	if (rawPath.endsWith('.om')) {
		const domain = extractDomain(rawPath);
		if (domain) {
			const tLatest = Date.now();
			const ourLatest = await readR2LatestCached(env.TILE_CACHE, domain);
			latestMs = Date.now() - tLatest;
			if (!ourLatest) {
				return new Response(
					JSON.stringify({
						error: 'cold-r2',
						message: `No R2 latest.json for ${domain} yet; warmer will populate.`,
						domain
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
			const canonical = buildCanonicalOmPath(rawPath, ourLatest.reference_time);
			if (canonical) upstreamPath = canonical.path;
			referenceTime = ourLatest.reference_time;
		}
	}

	const upstreamUrl = `${UPSTREAM_HOST}${upstreamPath}`;
	const r2Key = upstreamPath.replace(/^\//, '');
	const ttl = pickTtl(upstreamPath);
	const r2Eligible = R2_OM_CACHEABLE(upstreamPath);

	if (forceRefresh) {
		if (r2Eligible) {
			await env.TILE_CACHE.delete(r2Key).catch(() => {});
		}
		await caches.default.delete(upstreamUrl).catch(() => {});
	}

	// Warm header is still supported for backward-compat (old scripts may send
	// it) but `_warmer-trigger.ts` is now the canonical warm entry point.
	if (warm) {
		if (r2Eligible) {
			context.waitUntil(warmR2(env, r2Key, upstreamUrl));
		}
		return new Response(null, { status: 202, headers: corsHeaders });
	}

	const rangeHeader = request.headers.get('Range');
	const range = rangeHeader ? parseRange(rangeHeader) : null;

	// ── TIER 1.5: CF edge cache via Cache API, keyed by CANONICAL URL. ──────
	// Pages Function responses are CF-Cache-Status=DYNAMIC by default, so
	// nothing auto-populates the edge cache. We use the Workers Cache API
	// explicitly. The key is the canonical URL (includes the runPath) so that
	// when a new run publishes and our client-side stripped URL translates to a
	// new canonical path, we naturally miss the cache and pull fresh from R2
	// — no purge logic needed. Old-run entries age out at the Cache-Control TTL.
	let cacheKey: Request | null = null;
	if (r2Eligible) {
		const cacheKeyInit: RequestInit = { method: 'GET' };
		if (rangeHeader) cacheKeyInit.headers = { Range: rangeHeader };
		cacheKey = new Request(`${new URL(request.url).origin}${upstreamPath}`, cacheKeyInit);
		const tEdge = Date.now();
		const edgeCached = await caches.default.match(cacheKey);
		if (edgeCached) {
			const resp = new Response(edgeCached.body, edgeCached);
			resp.headers.set(CACHE_STATUS_HEADER, 'HIT-EDGE');
			resp.headers.set('X-Surfr-Edge-Ms', String(Date.now() - tEdge));
			if (referenceTime) resp.headers.set('X-Surfr-Reference-Time', referenceTime);
			if (latestMs) resp.headers.set('X-Surfr-Latest-Ms', String(latestMs));
			return resp;
		}
	}

	// ── TIER 2: R2 (only for .om files). ─────────────────────────────────────
	if (r2Eligible) {
		try {
			const r2Obj = await env.TILE_CACHE.get(
				r2Key,
				range ? { range: { offset: range.offset, length: range.length } } : undefined
			);
			if (r2Obj) {
				const response = r2ToResponse(r2Obj, range, r2Obj.size, ttl, 'HIT-R2');
				if (referenceTime) response.headers.set('X-Surfr-Reference-Time', referenceTime);
				if (latestMs) response.headers.set('X-Surfr-Latest-Ms', String(latestMs));
				// Populate the edge cache with this exact (canonical URL, Range)
				// so the next hit at this PoP skips R2 entirely.
				if (cacheKey) {
					context.waitUntil(caches.default.put(cacheKey, response.clone()));
				}
				return response;
			}
		} catch (err) {
			console.warn('[r2-get] failed', r2Key, err);
		}
	}

	// ── TIER 3: origin (with CF's edge cache in front). ──────────────────────
	// This path should be rare for `.om` files once the warmer is running — the
	// warmer ensures R2 has everything for the current run, and the rewrite
	// above points clients at that run. Hit here means either (a) the client
	// asked for a validTime not in the current run (→ origin 404), (b) R2 is
	// cold for this specific file, or (c) something weird happened.
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

	// If origin gave us a tile, kick off an R2 fill in background so the next
	// user hits R2 directly regardless of their range.
	if (r2Eligible && upstream.ok) {
		context.waitUntil(warmR2(env, r2Key, upstreamUrl));
	}

	// Label reflects whether the upstream `fetch` itself came back from CF's
	// edge cache of the origin URL (fast) or was a true origin round-trip.
	const originStatus: string = forceRefresh
		? 'BYPASS'
		: upstreamMs < 200
			? 'HIT-ORIGIN-EDGE'
			: 'MISS-ORIGIN';

	const headers = new Headers(upstream.headers);
	for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
	headers.set('Cache-Control', `public, max-age=${ttl}`);
	headers.set(CACHE_STATUS_HEADER, originStatus);
	headers.set('X-Surfr-Upstream-Ms', String(upstreamMs));
	if (referenceTime) headers.set('X-Surfr-Reference-Time', referenceTime);
	if (latestMs) headers.set('X-Surfr-Latest-Ms', String(latestMs));
	if (forceRefresh) headers.set('X-Surfr-Refreshed', '1');

	const finalResponse = new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers
	});
	// Put the origin response into our Cache-API tier so the next byte-range
	// hit at this PoP skips R2 and origin.
	if (cacheKey && upstream.ok) {
		context.waitUntil(caches.default.put(cacheKey, finalResponse.clone()));
	}
	return finalResponse;
};
