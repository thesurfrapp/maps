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
};

type AnyWarmerResult = { domain: string; status: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const parseWarmerBody = (body: string): AnyWarmerResult[] => {
	try {
		const parsed = JSON.parse(body) as { results?: AnyWarmerResult[] };
		return parsed.results ?? [];
	} catch {
		return [];
	}
};

// Shared secret with the Pages Functions (_warmer-trigger requires it) and
// with our own HTTP entry-points below. Set via `wrangler secret put ADMIN_TOKEN`.
type Env = { ADMIN_TOKEN?: string };

const warmerAuthHeaders = (env: Env): Record<string, string> =>
	env.ADMIN_TOKEN ? { Authorization: `Bearer ${env.ADMIN_TOKEN}` } : {};

// Constant-time compare; accepts Authorization: Bearer or ?token=.
const isAuthorized = (request: Request, env: Env): boolean => {
	const secret = env.ADMIN_TOKEN;
	if (!secret) return false;
	const header = request.headers.get('Authorization');
	const presented = header?.toLowerCase().startsWith('bearer ')
		? header.slice(7).trim()
		: (new URL(request.url).searchParams.get('token') ?? '');
	if (presented.length !== secret.length) return false;
	let diff = 0;
	for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ presented.charCodeAt(i);
	return diff === 0;
};

const runTick = async (env: Env): Promise<string> => {
	const tStart = Date.now();
	const outcomes: DomainOutcome[] = [];
	for (const domain of DOMAINS) {
		const t0 = Date.now();
		try {
			const res = await fetch(`${WARMER_BASE}?domain=${domain}&wait=1`, {
				method: 'GET',
				headers: warmerAuthHeaders(env)
			});
			const body = await res.text();
			const result = parseWarmerBody(body).find((r) => r.domain === domain);
			outcomes.push({
				domain,
				status: res.status,
				ms: Date.now() - t0,
				warmerStatus: result?.status,
				bodyHead: body.slice(0, 400)
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

const runOneDomain = async (env: Env, domain: string): Promise<string> => {
	const t0 = Date.now();
	const res = await fetch(`${WARMER_BASE}?domain=${domain}&wait=1&force=1`, {
		method: 'GET',
		headers: warmerAuthHeaders(env)
	});
	const body = await res.text();
	const result = parseWarmerBody(body).find((r) => r.domain === domain);
	return JSON.stringify(
		{
			domain,
			status: res.status,
			ms: Date.now() - t0,
			warmerStatus: result?.status,
			bodyHead: body.slice(0, 400)
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

	// HTTP entry-points (both require the ADMIN_TOKEN shared secret, via
	// Authorization: Bearer or ?token= — fail-closed if the secret is unset):
	//   GET /              → full per-domain cron pass (same as scheduled tick)
	//   GET /force?domain=X → re-run the warmer for ONE domain, even if its
	//                         reference_time already matches our R2. Used for
	//                         bootstrap and manual recovery.
	async fetch(request: Request, env: Env): Promise<Response> {
		if (!isAuthorized(request, env)) {
			return new Response(JSON.stringify({ error: 'unauthorized' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		const url = new URL(request.url);
		if (url.pathname === '/force') {
			const domain = url.searchParams.get('domain');
			if (!domain || !DOMAINS.includes(domain as (typeof DOMAINS)[number])) {
				return new Response(
					JSON.stringify({ error: 'unknown or missing domain', known: DOMAINS }, null, 2),
					{ status: 400, headers: { 'Content-Type': 'application/json' } }
				);
			}
			const out = await runOneDomain(env, domain);
			return new Response(out, {
				headers: { 'Content-Type': 'application/json; charset=utf-8' }
			});
		}
		const out = await runTick(env);
		return new Response(out, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
	}
};
