// Shared-secret auth for the operational endpoints (_admin, _warmer-trigger,
// _debug/cache) and the cache-mutating request headers. The tile-serving
// paths stay public — the app's WebView fetches them without credentials.
//
// The secret lives in the `ADMIN_TOKEN` Pages secret (and a same-named secret
// on the worker-cron Worker, which calls _warmer-trigger). Set it with:
//   npx wrangler pages secret put ADMIN_TOKEN   (project: maps; then redeploy)
//   cd worker-cron && npx wrangler secret put ADMIN_TOKEN
//
// Fail-closed: if ADMIN_TOKEN is not configured, every guarded request is
// rejected rather than silently open.

export interface AuthEnv {
	ADMIN_TOKEN?: string;
}

// Constant-time string comparison (length leak is fine for a random token).
const timingSafeEquals = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
};

// Token from `Authorization: Bearer <t>` (preferred, used by worker-cron) or
// `?token=<t>` (browser convenience for the _admin dashboard links).
export const presentedToken = (request: Request): string => {
	const header = request.headers.get('Authorization');
	if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
	return new URL(request.url).searchParams.get('token') ?? '';
};

export const isAuthorized = (request: Request, env: AuthEnv): boolean => {
	const secret = env.ADMIN_TOKEN;
	if (!secret) return false;
	const presented = presentedToken(request);
	return presented.length > 0 && timingSafeEquals(presented, secret);
};

export const unauthorizedResponse = (env: AuthEnv): Response =>
	new Response(
		JSON.stringify(
			env.ADMIN_TOKEN
				? { error: 'unauthorized', message: 'Provide Authorization: Bearer <token> or ?token=' }
				: {
						error: 'auth-not-configured',
						message: 'Set the ADMIN_TOKEN secret on this deployment.'
					}
		),
		{
			status: env.ADMIN_TOKEN ? 401 : 503,
			headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
		}
	);
