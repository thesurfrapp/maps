// Cache Reserve re-warmer. Called by the cron worker AFTER a per-domain
// `/tiles/_warmer-trigger` reports a fresh `warmed` run.
//
// Why this matters: Cache Reserve is the global, persistent tier sitting
// between edge PoPs and origin. A single `fetch(url, { cf: {
// cacheEverything: true } })` from this cron worker populates Cache
// Reserve, so the next user miss at any PoP worldwide gets a CR HIT
// (~100-200 ms), instead of going all the way to our worker → R2 (up to
// 6 s for the 168 MB icon-global).
//
// Pre-April 2026 this didn't actually populate CR — we were on a Pages
// Function whose Orange-to-Orange routing bypassed CR. Tile-serving is
// now on a standalone Worker (`worker-tiles/` at `tiles.thesurfr.app`),
// which runs directly on the zone — CR writes through there.
//
// The CF API purge feature is intentionally NOT included here. URLs are
// run-path-scoped (`.../<YYYY/MM/DD/HHmmZ>/<vt>.om`) — every new run
// produces fresh URLs, so old-run CR entries naturally age out at the
// 30 d TTL. No active purge needed.

// Match the cron-side warm horizon to the server-side warm horizon
// (DEFAULT_HORIZON_HOURS / EXTENDED_HORIZON_HOURS in
// functions/lib/warmer.ts). Any validTime R2 has, CF Cache Reserve
// should also have pre-filled.
const DEFAULT_REWARM_HORIZON_HOURS = 72;
const EXTENDED_REWARM_HORIZON_HOURS = 5 * 24;
const EXTENDED_REWARM_DOMAINS = new Set([
	'ncep_gfs013',
	'ncep_gfs025',
	'ecmwf_ifs025',
	'dwd_icon',
	'dwd_icon_d2'
]);
const horizonHoursFor = (domain: string): number =>
	EXTENDED_REWARM_DOMAINS.has(domain)
		? EXTENDED_REWARM_HORIZON_HOURS
		: DEFAULT_REWARM_HORIZON_HOURS;

// Per-URL rewarm concurrency. Kept low so we don't saturate the cron PoP's
// outbound and the rewarmer worker's stream-drain budget.
const REWARM_CONCURRENCY = 4;

const fmtValidTime = (iso: string): string => {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
};

const fmtRunPath = (isoRefTime: string): string => {
	const d = new Date(isoRefTime);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
};

// Build the canonical client-facing URL for a given (domain, runPath, validTime).
// Must exactly match what the client constructs in `src/lib/url.ts:getOMUrl`.
// New-architecture paths: tiles.thesurfr.app/data_spatial/...
const canonicalUrl = (domain: string, runPath: string, iso: string): string =>
	`https://tiles.thesurfr.app/data_spatial/${domain}/${runPath}/${fmtValidTime(iso)}.om`;

const capValidTimes = (validTimes: string[], referenceTime: string, domain: string): string[] => {
	const refMs = new Date(referenceTime).getTime();
	const cutoffMs = refMs + horizonHoursFor(domain) * 3600 * 1000;
	return validTimes.filter((iso) => new Date(iso).getTime() <= cutoffMs);
};

export type RewarmOutcome = {
	url: string;
	status: number;
	ms: number;
	bytes: number;
	contentLength: number;
	cfCacheStatus: string | null;
};

// Dispatch one URL rewarm via the service-bound companion `surfr-tile-
// rewarmer` Worker. Each call fires a fresh Worker invocation with its
// own 30 s CPU budget — so dispatching 73 × 168 MB drains from one cron
// invocation doesn't blow our budget. A same-Worker self-fetch loop is
// blocked by CF; service bindings route internally and work reliably.
type RewarmerService = { fetch(request: Request): Promise<Response> };

const rewarmOne = async (url: string, rewarmer: RewarmerService): Promise<RewarmOutcome> => {
	const t0 = Date.now();
	try {
		const dispatch = new Request(
			`https://rewarmer.internal/rewarm?url=${encodeURIComponent(url)}`,
			{ method: 'GET' }
		);
		const res = await rewarmer.fetch(dispatch);
		if (!res.ok) {
			const body = await res.text().catch(() => '(body read failed)');
			console.warn('[rewarmOne] non-OK', res.status, body.slice(0, 200));
			return {
				url,
				status: res.status,
				ms: Date.now() - t0,
				bytes: 0,
				contentLength: 0,
				cfCacheStatus: null
			};
		}
		return (await res.json()) as RewarmOutcome;
	} catch (err) {
		console.warn('[rewarmOne] threw', url, String(err));
		return {
			url,
			status: -1,
			ms: Date.now() - t0,
			bytes: 0,
			contentLength: 0,
			cfCacheStatus: null
		};
	}
};

const runBounded = async <T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>
): Promise<R[]> => {
	const results: R[] = new Array(items.length);
	let i = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const idx = i++;
			if (idx >= items.length) return;
			results[idx] = await fn(items[idx]);
		}
	});
	await Promise.all(workers);
	return results;
};

export type RewarmResult = {
	domain: string;
	urls: number;
	ok: number;
	fail: number;
	totalMs: number;
	byCfCacheStatus: Record<string, number>;
};

export const rewarmDomain = async (
	domain: string,
	referenceTime: string,
	validTimes: string[],
	rewarmer: RewarmerService
): Promise<RewarmResult> => {
	const runPath = fmtRunPath(referenceTime);
	const capped = capValidTimes(validTimes, referenceTime, domain);
	const urls = capped.map((iso) => canonicalUrl(domain, runPath, iso));
	const t0 = Date.now();
	const rewarmResults = await runBounded(urls, REWARM_CONCURRENCY, (u) => rewarmOne(u, rewarmer));
	const ok = rewarmResults.filter((r) => r.status >= 200 && r.status < 400).length;
	const fail = rewarmResults.length - ok;
	const byCfCacheStatus: Record<string, number> = {};
	for (const r of rewarmResults) {
		const k = r.cfCacheStatus ?? 'null';
		byCfCacheStatus[k] = (byCfCacheStatus[k] ?? 0) + 1;
	}
	return {
		domain,
		urls: urls.length,
		ok,
		fail,
		totalMs: Date.now() - t0,
		byCfCacheStatus
	};
};
