// Cron-only Worker. Every 5 min it walks the domain list, firing one blocking
// HTTP call per domain to the Pages Function warmer. Sharding per-domain
// gives each Pages Function invocation its own CPU/subrequest budget, and
// sequential domains cap global upstream load at `OM_FILE_CONCURRENCY` (4)
// concurrent requests.
//
// Each per-domain call waits on `?wait=1`. Most ticks are no-ops
// (status = "unchanged") and return in < 1 s. A tick that catches a new run
// for one domain takes 1–3 min; the catastrophic first-tick that warms
// everything is bounded by the 15-min scheduled-event walltime cap.
// Domains we don't reach on a slow tick get picked up on the next one — the
// warmer's per-file `head` check makes restarts idempotent.
//
// URLs include the runPath (see ADR 0001), so new runs produce new URLs and
// old-run edge entries simply age out at the 30 d Cache Rule TTL. No CF
// cache purge is needed — this worker does not talk to the Cloudflare API.

import { rewarmDomain, type RewarmResult } from './purge';

type Env = {
	REWARMER: { fetch(request: Request): Promise<Response> };
};

const WARMER_BASE = 'https://maps.thesurfr.app/tiles/_warmer-trigger';

// Keep in sync with `functions/lib/domains.ts`. Drift is self-healing: any
// domain missing here simply won't get its dedicated per-tick slot (but the
// Pages Function still handles it if hit manually).
const DOMAINS = [
	'metno_nordic_pp',
	'meteofrance_arome_france_hd',
	'dwd_icon_d2',
	'knmi_harmonie_arome_netherlands',
	'ukmo_uk_deterministic_2km',
	'meteofrance_arome_france0025',
	'cmc_gem_hrdps',
	'ncep_hrrr_conus',
	'knmi_harmonie_arome_europe',
	'ecmwf_ifs025',
	'dwd_icon',
	'ncep_gfs013',
	'ncep_gfs025'
] as const;

// Small pause between domains so upstream gets breathing room between bursts
// even when several domains have new runs queued up in one tick.
const BETWEEN_DOMAIN_MS = 1500;

type DomainOutcome = {
	domain: string;
	status: number;
	ms: number;
	warmerStatus?: string;
	bodyHead: string;
	rewarm?: RewarmResult;
};

// Subset of `DomainResult` from `functions/lib/warmer.ts` that we care
// about for the CR-rewarm dispatch. The 'warmed' branch carries
// referenceTime + validTimes — the inputs we need to rebuild the client-
// facing URLs and fire `cf.cacheEverything` GETs against them.
type AnyWarmerResult = {
	domain: string;
	status: string;
	referenceTime?: string;
	validTimes?: string[];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parseWarmerBody = (body: string): AnyWarmerResult[] => {
	try {
		const parsed = JSON.parse(body) as { results?: AnyWarmerResult[] };
		return parsed.results ?? [];
	} catch {
		return [];
	}
};

// Dispatch a CR rewarm for one domain, only if the warmer reported a
// fresh `warmed` status (meaning a new run was just pulled into R2).
// Subsequent identical-run ticks skip — CR is already populated.
const maybeRewarm = async (
	result: AnyWarmerResult | undefined,
	rewarmer: Env['REWARMER']
): Promise<RewarmResult | undefined> => {
	if (!result || result.status !== 'warmed') return undefined;
	if (!result.referenceTime || !result.validTimes?.length) return undefined;
	try {
		return await rewarmDomain(result.domain, result.referenceTime, result.validTimes, rewarmer);
	} catch (err) {
		console.warn('[rewarm] threw', result.domain, String(err));
		return undefined;
	}
};

const runTick = async (env: Env): Promise<string> => {
	const tStart = Date.now();
	const outcomes: DomainOutcome[] = [];
	for (const domain of DOMAINS) {
		const t0 = Date.now();
		try {
			const res = await fetch(`${WARMER_BASE}?domain=${domain}&wait=1`, { method: 'GET' });
			const body = await res.text();
			const result = parseWarmerBody(body).find((r) => r.domain === domain);
			const rewarm = await maybeRewarm(result, env.REWARMER);
			outcomes.push({
				domain,
				status: res.status,
				ms: Date.now() - t0,
				warmerStatus: result?.status,
				bodyHead: body.slice(0, 400),
				rewarm
			});
		} catch (err) {
			outcomes.push({ domain, status: -1, ms: Date.now() - t0, bodyHead: String(err) });
		}
		await sleep(BETWEEN_DOMAIN_MS);
	}
	return JSON.stringify(
		{
			startedAt: new Date(tStart).toISOString(),
			wallMs: Date.now() - tStart,
			domains: outcomes.length,
			outcomes
		},
		null,
		2
	);
};

const runOneDomain = async (domain: string, env: Env): Promise<string> => {
	const t0 = Date.now();
	const res = await fetch(`${WARMER_BASE}?domain=${domain}&wait=1&force=1`, { method: 'GET' });
	const body = await res.text();
	const result = parseWarmerBody(body).find((r) => r.domain === domain);
	const rewarm = await maybeRewarm(result, env.REWARMER);
	return JSON.stringify(
		{
			domain,
			status: res.status,
			ms: Date.now() - t0,
			warmerStatus: result?.status,
			bodyHead: body.slice(0, 400),
			rewarm
		},
		null,
		2
	);
};

export default {
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(
			runTick(env)
				.then((out) => console.log('[cron] tick complete', out))
				.catch((err) => console.error('[cron] tick failed', err))
		);
	},

	// HTTP entry-points:
	//   GET /              → full per-domain cron pass (same as scheduled tick)
	//   GET /force?domain=X → re-run the warmer for ONE domain, even if its
	//                         reference_time already matches our R2. Used for
	//                         bootstrap and manual recovery.
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/force') {
			const domain = url.searchParams.get('domain');
			if (!domain || !DOMAINS.includes(domain as (typeof DOMAINS)[number])) {
				return new Response(
					JSON.stringify({ error: 'unknown or missing domain', known: DOMAINS }, null, 2),
					{ status: 400, headers: { 'Content-Type': 'application/json' } }
				);
			}
			const out = await runOneDomain(domain, env);
			return new Response(out, {
				headers: { 'Content-Type': 'application/json; charset=utf-8' }
			});
		}
		const out = await runTick(env);
		return new Response(out, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
	}
};
