// Tiny cron-only Worker. Every 5 min it walks the domain list, firing one
// blocking HTTP call per domain to the Pages Function warmer. We shard per-
// domain for two reasons:
//   1. Each Pages Function invocation gets its own CPU/subrequest budget —
//      avoids the "metno succeeded but everything else got 'no-upstream'"
//      tail we saw when warmAll ran in a single invocation.
//   2. Sequential domains means upstream Open-Meteo never sees more than
//      `OM_FILE_CONCURRENCY` (currently 4) concurrent requests from us
//      globally. No bursts, no cross-domain parallelism.
//
// We wait for each domain (`?wait=1`) before moving on. Most ticks are no-ops
// (status = "unchanged") and return in < 1 s. A tick that catches a new run
// for one domain can take 1–3 min; a catastrophic first-tick that needs to
// warm everything is bounded by the 15-min scheduled-event walltime cap.
// Domains we don't reach on a slow tick get picked up on the next one — the
// warmer's per-file `head` check makes restarts idempotent.
//
// When a per-domain call reports `status: "warmed"` — meaning a fresh run
// just swapped — we also purge CF edge cache for that domain's stripped URLs
// and re-warm them by fetching with `cf: { cacheEverything: true }`. This
// keeps client-facing URLs stable but flushes old-run bytes from CF edge
// as soon as R2 holds the new run. See `./purge.ts` for the rationale.

import { type PurgeResult, purgeDomain } from './purge';

const WARMER_BASE = 'https://maps.thesurfr.app/tiles/_warmer-trigger';
const CLIENT_ORIGIN = 'https://maps.thesurfr.app';

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
	'dwd_icon_eu',
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
	purge?: PurgeResult;
	bodyHead: string;
};

type Env = {
	CF_PURGE_TOKEN?: string;
	CF_ZONE_ID?: string;
};

type WarmedResult = {
	domain: string;
	status: 'warmed';
	referenceTime: string;
	validTimes: string[];
};

type AnyWarmerResult = { domain: string; status: string; referenceTime?: string; validTimes?: string[] };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parseWarmerBody = (body: string): AnyWarmerResult[] => {
	try {
		const parsed = JSON.parse(body) as { results?: AnyWarmerResult[] };
		return parsed.results ?? [];
	} catch {
		return [];
	}
};

const isWarmed = (r: AnyWarmerResult): r is WarmedResult =>
	r.status === 'warmed' && Array.isArray(r.validTimes) && typeof r.referenceTime === 'string';

const runTick = async (env: Env): Promise<string> => {
	const tStart = Date.now();
	const outcomes: DomainOutcome[] = [];
	for (const domain of DOMAINS) {
		const t0 = Date.now();
		try {
			const res = await fetch(`${WARMER_BASE}?domain=${domain}&wait=1`, {
				method: 'GET'
			});
			const body = await res.text();
			const warmerResults = parseWarmerBody(body);
			const result = warmerResults.find((r) => r.domain === domain);
			const outcome: DomainOutcome = {
				domain,
				status: res.status,
				ms: Date.now() - t0,
				warmerStatus: result?.status,
				bodyHead: body.slice(0, 400)
			};
			if (result && isWarmed(result)) {
				outcome.purge = await purgeDomain(
					env,
					CLIENT_ORIGIN,
					domain,
					result.referenceTime,
					result.validTimes
				);
			}
			outcomes.push(outcome);
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

export default {
	async scheduled(
		_event: ScheduledEvent,
		env: Env,
		ctx: ExecutionContext
	): Promise<void> {
		ctx.waitUntil(
			runTick(env)
				.then((out) => console.log('[cron] tick complete', out))
				.catch((err) => console.error('[cron] tick failed', err))
		);
	},

	// HTTP entry-points:
	//   GET /              → full per-domain cron pass (same as scheduled tick)
	//   GET /force?domain=X → purge + re-warm CF edge cache for ONE domain,
	//                         regardless of whether the run just swapped. Used
	//                         for bootstrap and manual recovery.
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
			const meta = await fetchMetaJson(domain);
			if (!meta) {
				return new Response(
					JSON.stringify({ error: 'meta.json unreachable', domain }, null, 2),
					{ status: 502, headers: { 'Content-Type': 'application/json' } }
				);
			}
			const purge = await purgeDomain(
				env,
				CLIENT_ORIGIN,
				domain,
				meta.reference_time,
				meta.valid_times
			);
			return new Response(JSON.stringify({ domain, referenceTime: meta.reference_time, purge }, null, 2), {
				headers: { 'Content-Type': 'application/json; charset=utf-8' }
			});
		}
		const out = await runTick(env);
		return new Response(out, {
			headers: { 'Content-Type': 'application/json; charset=utf-8' }
		});
	}
};

// Fetches meta.json for a domain (served by the Pages Function from R2) and
// returns the essentials needed for purge + re-warm.
const fetchMetaJson = async (
	domain: string
): Promise<{ reference_time: string; valid_times: string[] } | null> => {
	try {
		const res = await fetch(`${CLIENT_ORIGIN}/tiles/data_spatial/${domain}/meta.json`);
		if (!res.ok) return null;
		const parsed = (await res.json()) as { reference_time?: string; valid_times?: string[] };
		if (!parsed.reference_time || !Array.isArray(parsed.valid_times)) return null;
		return { reference_time: parsed.reference_time, valid_times: parsed.valid_times };
	} catch {
		return null;
	}
};
