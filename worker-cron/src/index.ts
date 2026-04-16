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
	bodyHead: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const runTick = async (): Promise<string> => {
	const tStart = Date.now();
	const outcomes: DomainOutcome[] = [];
	for (const domain of DOMAINS) {
		const t0 = Date.now();
		try {
			const res = await fetch(`${WARMER_BASE}?domain=${domain}&wait=1`, {
				method: 'GET'
			});
			const body = await res.text();
			outcomes.push({ domain, status: res.status, ms: Date.now() - t0, bodyHead: body.slice(0, 400) });
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
		_env: unknown,
		ctx: ExecutionContext
	): Promise<void> {
		ctx.waitUntil(
			runTick()
				.then((out) => console.log('[cron] tick complete', out))
				.catch((err) => console.error('[cron] tick failed', err))
		);
	},

	// Manual trigger — `curl https://<worker>.workers.dev/` fires a full
	// per-domain pass and returns the summary JSON. Useful for bootstrap and
	// ad-hoc re-warms.
	async fetch(): Promise<Response> {
		const out = await runTick();
		return new Response(out, {
			headers: { 'Content-Type': 'application/json; charset=utf-8' }
		});
	}
};
