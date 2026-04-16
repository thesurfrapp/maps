// Tiny cron-only Worker. Every 5 minutes it POSTs to the Pages Function's
// warmer endpoint, which does the actual R2 warming. We keep the cron in a
// separate Worker because Pages Functions don't support scheduled() handlers.
//
// This Worker owns nothing stateful — no R2 bindings, no state — just fires a
// fetch and exits. All work happens inside the Pages Function via waitUntil.

const WARMER_URL = 'https://maps.thesurfr.app/tiles/_warmer-trigger';

export default {
	async scheduled(
		_event: ScheduledEvent,
		_env: unknown,
		ctx: ExecutionContext
	): Promise<void> {
		ctx.waitUntil(
			fetch(WARMER_URL, { method: 'GET' })
				.then(async (res) => {
					const body = await res.text();
					console.log('[cron] warmer hit', res.status, body.slice(0, 500));
				})
				.catch((err) => console.error('[cron] warmer fetch failed', err))
		);
	},

	// Manual trigger path — `curl https://<worker>.workers.dev/` — convenient for
	// kicking off a tick from a phone or laptop without waiting for the cron.
	async fetch(): Promise<Response> {
		const res = await fetch(WARMER_URL, { method: 'GET' });
		const text = await res.text();
		return new Response(`forwarded to warmer (status ${res.status}):\n\n${text}`, {
			headers: { 'Content-Type': 'text/plain' }
		});
	}
};
