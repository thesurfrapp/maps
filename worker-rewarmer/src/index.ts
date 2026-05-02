// Single-URL rewarmer. Each invocation handles ONE url; returns a tiny
// JSON outcome. Meant to be called by the cron worker's `rewarmDomain`
// dispatcher — the cron fires N parallel HTTPs here so each large-file
// drain gets its own 30-second CPU budget.
//
// Why this matters now (April 2026): we migrated tile-serving from a
// Pages Function to a standalone Worker (`worker-tiles/`) on
// `tiles.thesurfr.app`. Pages Function's Orange-to-Orange routing was
// bypassing Cache Reserve. The new Worker on a custom domain runs
// directly on the zone, so a `cf: { cacheEverything: true }` GET against
// any tile URL on `tiles.thesurfr.app` now actually writes through to
// Cache Reserve.
//
// Response shape (matches `RewarmOutcome` in worker-cron/src/purge.ts):
//   { url, status, ms, bytes, contentLength, cfCacheStatus }

type RewarmOutcome = {
	url: string;
	status: number;
	ms: number;
	bytes: number;
	contentLength: number;
	cfCacheStatus: string | null;
};

const rewarm = async (target: string): Promise<RewarmOutcome> => {
	const t0 = Date.now();
	try {
		const res = await fetch(target, {
			method: 'GET',
			cf: { cacheEverything: true, cacheTtl: 30 * 86400 }
		});
		const contentLength = Number(res.headers.get('Content-Length') ?? '0');
		const cfCacheStatus = res.headers.get('CF-Cache-Status');
		if (res.body) {
			// pipeTo streams through without buffering into JS memory. Draining
			// is what triggers CF to finalise the cache write (including Cache
			// Reserve for eligible responses — full 200 with Content-Length and
			// ≥10 h TTL).
			await res.body.pipeTo(new WritableStream());
		}
		return {
			url: target,
			status: res.status,
			ms: Date.now() - t0,
			bytes: contentLength,
			contentLength,
			cfCacheStatus
		};
	} catch (err) {
		console.warn('[rewarm] threw', target, String(err));
		return {
			url: target,
			status: -1,
			ms: Date.now() - t0,
			bytes: 0,
			contentLength: 0,
			cfCacheStatus: null
		};
	}
};

// Hostnames the rewarmer is allowed to fetch. Defensive — prevents this
// worker from being abused as an open proxy if the URL leaked. Tile URLs
// live on `tiles.thesurfr.app` since the post-O2O migration. The old
// `maps.thesurfr.app/tiles/...` host is kept on the allow-list for the
// transition window so any in-flight callers from the cron's old
// configuration still work; safe to remove after backwards compat
// window closes.
const ALLOWED_HOSTNAMES = new Set(['tiles.thesurfr.app', 'maps.thesurfr.app']);

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== '/rewarm') {
			return new Response(
				JSON.stringify({ error: 'use /rewarm?url=<absolute-url>' }, null, 2),
				{ status: 404, headers: { 'Content-Type': 'application/json' } }
			);
		}
		const target = url.searchParams.get('url');
		if (!target) {
			return new Response(JSON.stringify({ error: 'missing url' }, null, 2), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		try {
			const parsed = new URL(target);
			if (!ALLOWED_HOSTNAMES.has(parsed.hostname)) {
				return new Response(
					JSON.stringify(
						{ error: 'url host not allowed', hostname: parsed.hostname },
						null,
						2
					),
					{ status: 400, headers: { 'Content-Type': 'application/json' } }
				);
			}
		} catch {
			return new Response(JSON.stringify({ error: 'invalid url' }, null, 2), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		const outcome = await rewarm(target);
		return new Response(JSON.stringify(outcome), {
			headers: { 'Content-Type': 'application/json' }
		});
	}
};
