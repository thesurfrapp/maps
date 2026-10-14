// Upstream admission for the /stations proxy (SRF-2994).
//
// Every upstream call spends the shared live-wind `maps` token's rate limit, so
// the proxy must not let a burst of requests turn into a burst of upstream calls:
// - concurrent callers for the same URL share ONE request (in flight per isolate);
// - after a failure, the URL cools down for `backoffMs`: callers get the last good
//   copy (or an error) instead of another upstream call.
// The PoP cache in front of this stays the main bound across isolates; this gate
// covers the gaps the cache cannot: simultaneous misses and failing upstreams.

export interface UpstreamResult {
	ok: boolean;
	status: number;
	body: string;
	etag: string | null;
}

export class UpstreamGate {
	private readonly inflight = new Map<string, Promise<UpstreamResult>>();
	private readonly failedAt = new Map<string, number>();

	constructor(
		private readonly backoffMs: number,
		private readonly now: () => number = Date.now
	) {}

	/** True while a recent failure for `url` is still cooling down. */
	inBackoff(url: string): boolean {
		const at = this.failedAt.get(url);
		return at !== undefined && this.now() - at < this.backoffMs;
	}

	/** One upstream request per URL at a time; concurrent callers share it. */
	fetch(url: string, doFetch: () => Promise<Response>): Promise<UpstreamResult> {
		const running = this.inflight.get(url);
		if (running) return running;

		const request = (async (): Promise<UpstreamResult> => {
			try {
				const res = await doFetch();
				const body = res.ok ? await res.text() : '';
				if (res.ok) this.failedAt.delete(url);
				else this.failedAt.set(url, this.now());
				return { ok: res.ok, status: res.status, body, etag: res.headers.get('ETag') };
			} catch {
				this.failedAt.set(url, this.now());
				return { ok: false, status: 502, body: '', etag: null };
			}
		})();
		this.inflight.set(url, request);
		request.finally(() => {
			if (this.inflight.get(url) === request) this.inflight.delete(url);
		});
		return request;
	}
}

/** Own-property lookup: prototype names (constructor, __proto__, …) are not files. */
export function lookupFile<T>(files: Record<string, T>, name: string): T | undefined {
	return Object.hasOwn(files, name) ? files[name] : undefined;
}
