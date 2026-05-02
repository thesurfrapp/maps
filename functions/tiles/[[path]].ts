// Cloudflare Pages Function — tile proxy backed by R2.
//
//   Browser ─► CF edge cache (auto-populated from our Cache-Control headers)
//              └► miss ─► this Function runs
//                         ├► For `.om`  : serve from R2 (HIT-R2) or origin (MISS).
//                         │               URL includes the run-path (YYYY/MM/DD/HHmmZ)
//                         │               so each run has an immutable cache key.
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
const ERROR_404_TTL = 60 * 60;

const FORCE_REFRESH_HEADER = 'X-Surfr-Force-Refresh';
const WARM_HEADER = 'X-Surfr-Warm';
const CACHE_STATUS_HEADER = 'X-Surfr-Cache-Status';

const R2_OM_CACHEABLE = (path: string) => path.endsWith('.om');
const R2_JSON_KEY = (path: string): string | null => {
	// Only `latest.json` is R2-canonical. It's written by the warmer as the
	// last step of a successful run — so when a client sees a reference_time,
	// every .om file in that run is already on R2. Upstream's latest.json
	// carries valid_times + variables, so no separate meta.json is needed.
	if (path.endsWith('/latest.json')) return path.replace(/^\//, '');
	return null;
};

// Paths we refuse to proxy upstream. `in-progress.json` advertises a run
// upstream is still uploading, so any .om URL derived from it would miss.
// `meta.json` is upstream's per-run snapshot — we've consolidated on
// latest.json and don't want clients accidentally reading upstream's copy.
const isBlockedJson = (path: string): boolean =>
	path.endsWith('/in-progress.json') || path.endsWith('/meta.json');

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
	'Access-Control-Allow-Headers': `Range, If-Match, If-None-Match, If-Modified-Since, ${FORCE_REFRESH_HEADER}, ${WARM_HEADER}`,
	'Access-Control-Expose-Headers':
		'ETag, Content-Range, Content-Length, Accept-Ranges, X-Surfr-Cache-Status, X-Surfr-Refreshed, X-Surfr-Upstream-Ms',
	'Access-Control-Max-Age': '3000'
};

// Parse a Range header. Returns either an absolute range
// (`bytes=N-M` / `bytes=N-`) or a suffix range (`bytes=-N` = "last N bytes").
// R2's `get` accepts both forms, so we keep them distinct rather than
// resolving suffix→absolute up front (we'd need totalSize to do that).
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

// Build a Response from an R2 object body. Handles Range (206) vs full (200).
// URLs include the run-path so `.om` bytes are immutable — safe to mark so.
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
// `latest.json` / `meta.json` are pointers to a moving target — no browser
// caching, otherwise clients build .om URLs with a stale runPath.
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
		return serveJsonFromR2(env.TILE_CACHE, r2JsonKey);
	}

	// Reject upstream-advertised in-progress runs and legacy meta.json — all
	// metadata comes from our R2 latest.json, which is only flipped after a
	// run is fully warmed.
	if (isBlockedJson(rawPath)) {
		return new Response(
			JSON.stringify({ error: 'blocked', message: 'use latest.json instead' }),
			{
				status: 404,
				headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders }
			}
		);
	}

	// ── .om — client sends the canonical path including runPath. ────────────
	const upstreamUrl = `${UPSTREAM_HOST}${rawPath}`;
	const r2Key = rawPath.replace(/^\//, '');
	const r2Eligible = R2_OM_CACHEABLE(rawPath);

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

	// ── TIER 2: R2 (only for .om files). ─────────────────────────────────────
	// The CF edge cache populated by the cron worker (after each run swap it
	// purges + cacheEverything-re-warms stripped URLs) should absorb 99% of
	// reads before they ever reach here. This path is the safety net.
	if (r2Eligible) {
		try {
			const r2Range = range
				? range.kind === 'suffix'
					? { range: { suffix: range.suffix } }
					: { range: { offset: range.offset, length: range.length } }
				: undefined;
			const r2Obj = await env.TILE_CACHE.get(r2Key, r2Range);
			if (r2Obj) {
				return r2ToResponse(r2Obj, range, r2Obj.size, 'HIT-R2');
			}
		} catch (err) {
			console.warn('[r2-get] failed', r2Key, err);
		}
	}

	// ── TIER 3: origin (with CF's edge cache in front). ──────────────────────
	// This path should be rare for `.om` files once the warmer is running — the
	// warmer ensures R2 has everything for the current run, and the client URL
	// points at that run directly. Hit here means either (a) the client asked
	// for a validTime or run not in R2, (b) R2 is cold for this specific file,
	// or (c) something weird happened.
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
	headers.set('Cache-Control', `public, max-age=${OM_FILE_TTL}, immutable`);
	headers.set(CACHE_STATUS_HEADER, originStatus);
	headers.set('X-Surfr-Upstream-Ms', String(upstreamMs));
	if (forceRefresh) headers.set('X-Surfr-Refreshed', '1');

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers
	});
};
