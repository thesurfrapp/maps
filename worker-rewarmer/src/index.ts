// Single-URL rewarmer. Each invocation handles ONE url; returns a tiny
// JSON outcome. Meant to be called by the cron worker's `rewarmDomain`
// dispatcher — the cron fires N parallel HTTPs here so each large-file
// drain gets its own 30-second CPU budget.
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
		// Defensive — only rewarm URLs on maps.thesurfr.app to avoid being
		// used as an open proxy.
		try {
			const parsed = new URL(target);
			if (parsed.hostname !== 'maps.thesurfr.app') {
				return new Response(
					JSON.stringify({ error: 'url host not allowed', hostname: parsed.hostname }, null, 2),
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
