// HTTP entry-point for the warmer. Hit every 5 min by a tiny companion Worker
// (see `worker-cron/`) or manually via curl.
//
// No auth: the endpoint is idempotent (warmer skips up-to-date domains) and the
// worst-case abuse is redundant R2 write ops. Revisit if that changes.
//
// Query params:
//   ?domain=<name>   Warm a single domain (optional). Default = all 13.
//
// Response: JSON summary of per-domain outcomes. Plain text exits for errors.
//
// NOTE on timing: Pages Functions have a request CPU cap but background work
// via `waitUntil` continues after the response is sent. Because a full warm of
// all 13 domains can take many minutes, we respond immediately with an
// "accepted" JSON and let the actual work run via `waitUntil`. The cron worker
// hits this endpoint on its own schedule; it doesn't need to wait for
// completion.

import { WARMED_DOMAINS } from '../lib/domains';
import { type DomainResult, type Env, warmAll, warmDomain } from '../lib/warmer';

export const onRequestGet: PagesFunction<Env> = async (context) => {
	const url = new URL(context.request.url);
	const domainFilter = url.searchParams.get('domain');

	// Validate domain param if supplied.
	if (domainFilter && !WARMED_DOMAINS.includes(domainFilter)) {
		return new Response(
			JSON.stringify({
				error: 'unknown domain',
				domain: domainFilter,
				known: WARMED_DOMAINS
			}),
			{ status: 400, headers: { 'Content-Type': 'application/json' } }
		);
	}

	// If ?wait=1 is set, we actually wait for the warm to complete and return
	// the result inline. Useful for manual testing / bootstrap; the cron
	// never uses it.
	const wait = url.searchParams.get('wait') === '1';
	// ?force=1 skips the "our R2 already has this reference_time" short-
	// circuit and re-runs the warmer end-to-end. Used for recovery when a
	// prior warm looks bad. Only applicable with ?domain=<x>.
	const force = url.searchParams.get('force') === '1';

	const run = async (): Promise<DomainResult[]> =>
		domainFilter
			? [await warmDomain(context.env, domainFilter, { force })]
			: await warmAll(context.env);

	if (wait) {
		const results = await run();
		return new Response(JSON.stringify({ started: new Date().toISOString(), results }, null, 2), {
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Fire-and-forget so the caller (cron worker) doesn't have to hold an HTTP
	// connection open for minutes.
	context.waitUntil(
		(async () => {
			const t0 = Date.now();
			const results = await run();
			console.log(
				'[warmer] tick complete',
				JSON.stringify({
					ms: Date.now() - t0,
					byStatus: results.reduce<Record<string, number>>((acc, r) => {
						acc[r.status] = (acc[r.status] ?? 0) + 1;
						return acc;
					}, {}),
					results
				})
			);
		})()
	);

	return new Response(
		JSON.stringify({
			accepted: true,
			startedAt: new Date().toISOString(),
			domains: domainFilter ? [domainFilter] : WARMED_DOMAINS
		}),
		{ headers: { 'Content-Type': 'application/json' } }
	);
};
