// CF cache purge, called by the cron worker AFTER a per-domain
// `/tiles/_warmer-trigger` call reports a fresh `warmed` run.
//
// Why this lives in the cron worker (not the Pages Function):
//   * Purge is a scheduled-only concern — no client request should ever cause
//     a purge. Keeping the CF API token out of the Pages Function shrinks the
//     blast radius.
//
// Why no re-warm here:
//   * CF purge is global (all PoPs drop the old bytes simultaneously).
//   * A re-warm from the cron worker only populates its own PoP's cache
//     (plus, ideally, the upper tier via Smart Tiered Cache). Since first-
//     miss cost at other PoPs is unavoidable regardless, the extra ~1 GB of
//     internal traffic per domain swap is wasted unless the upper tier
//     reliably serves it — which we couldn't confirm.
//   * First user at each cold PoP pays one miss per URL (reads the full
//     file from R2 via the Pages Function, populates local edge cache).
//     Subsequent users at the same PoP hit the 30-day edge cache.

const API_BASE = 'https://api.cloudflare.com/client/v4';
const PURGE_BATCH = 30; // Free-plan limit per purge_cache call.

// Only purge validTimes that any user might reach from the scrubber. Hours
// beyond this land as cold-edge-first-MISS, which is fine.
const PURGE_HORIZON_HOURS = 72;

type PurgeEnv = {
	CF_PURGE_TOKEN?: string;
	CF_ZONE_ID?: string;
};

// Build a stripped client-facing URL for a given (domain, validTime).
// Must exactly match what the client constructs in `src/lib/url.ts`.
const fmtValidTime = (iso: string): string => {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
};

const strippedUrl = (origin: string, domain: string, iso: string): string =>
	`${origin}/tiles/data_spatial/${domain}/${fmtValidTime(iso)}.om`;

const capValidTimes = (validTimes: string[], referenceTime: string): string[] => {
	const refMs = new Date(referenceTime).getTime();
	const cutoffMs = refMs + PURGE_HORIZON_HOURS * 3600 * 1000;
	return validTimes.filter((iso) => new Date(iso).getTime() <= cutoffMs);
};

const chunk = <T>(arr: T[], size: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
};

const purgeBatch = async (
	env: PurgeEnv,
	files: string[]
): Promise<{ ok: boolean; status: number; body?: string }> => {
	if (!env.CF_PURGE_TOKEN || !env.CF_ZONE_ID) {
		return { ok: false, status: 0, body: 'CF_PURGE_TOKEN or CF_ZONE_ID missing' };
	}
	const res = await fetch(`${API_BASE}/zones/${env.CF_ZONE_ID}/purge_cache`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.CF_PURGE_TOKEN}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ files })
	});
	const body = await res.text().catch(() => '');
	return { ok: res.ok, status: res.status, body: body.slice(0, 300) };
};

export type PurgeResult = {
	domain: string;
	urls: number;
	batches: Array<{ ok: boolean; status: number }>;
	totalMs: number;
};

export const purgeDomain = async (
	env: PurgeEnv,
	origin: string,
	domain: string,
	referenceTime: string,
	validTimes: string[]
): Promise<PurgeResult> => {
	const t0 = Date.now();
	const capped = capValidTimes(validTimes, referenceTime);
	const urls = capped.map((iso) => strippedUrl(origin, domain, iso));
	const batches: PurgeResult['batches'] = [];
	for (const batch of chunk(urls, PURGE_BATCH)) {
		const res = await purgeBatch(env, batch);
		batches.push({ ok: res.ok, status: res.status });
		if (!res.ok) console.warn('[purge] batch failed', res.status, res.body);
	}
	return { domain, urls: urls.length, batches, totalMs: Date.now() - t0 };
};
