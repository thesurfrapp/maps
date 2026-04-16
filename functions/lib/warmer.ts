// Core warm logic. Runs inside a Pages Function (HTTP trigger) and is invoked
// on a 5-min cron by a companion Worker.
//
// Per domain:
//   1. Fetch UPSTREAM latest.json.                               (authoritative)
//   2. Read OUR R2 latest.json.                                  (what we serve)
//   3. If reference_time matches → skip (nothing to do).
//   4. Else → fetch upstream meta.json for the new run.
//   5. Warm every .om in meta.valid_times to R2, concurrency=8.
//   6. Atomic swap: put new meta.json, then put new latest.json.
//      Only now do clients see the new run.
//   7. Delete old-run .om files from R2 (prefix-list + filter).
//
// All R2 writes use `env.TILE_CACHE`. The Pages Function's tile proxy reads
// from the same bucket, so rewriting run paths in [[path]].ts will
// transparently pick up the new run as soon as step 6 lands.

import { WARMED_DOMAINS } from './domains';

export interface Env {
	TILE_CACHE: R2Bucket;
}

const UPSTREAM_HOST = 'https://map-tiles.open-meteo.com';
const OM_FILE_CONCURRENCY = 8;

// Cap each domain's warm at +72 h from the reference_time. Most kiters don't
// look beyond that horizon; shaving longer-range files cuts R2 writes + storage.
// Models with shorter horizons (HRRR ~18 h) naturally stay under this cap.
const MAX_HORIZON_HOURS = 72;

// Per-domain budget (ms) so one slow domain doesn't starve the others within a
// single 15-min scheduled-event cap. Domains are processed sequentially; a
// domain that runs out of budget gets completed on the next cron tick (its
// next run will still be behind upstream, but the diff logic catches up).
const PER_DOMAIN_TIMEOUT_MS = 4 * 60 * 1000; // 4 min

type UpstreamLatest = {
	reference_time: string; // ISO UTC, e.g. "2026-04-16T06:00:00Z"
	valid_times?: string[];
	variables?: string[];
	[k: string]: unknown;
};

type UpstreamMeta = {
	reference_time: string;
	valid_times: string[];
	variables?: string[];
	[k: string]: unknown;
};

// Format an ISO UTC reference time to the S3 run-path segment
// "YYYY/MM/DD/HHmmZ" used by Open-Meteo tile URLs.
export const fmtRunPath = (isoRefTime: string): string => {
	const d = new Date(isoRefTime);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
};

// Format an ISO UTC valid time to the per-file filename segment
// "YYYY-MM-DDTHHmm" (no separator between hour/min).
export const fmtValidTime = (iso: string): string => {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
};

const upstreamLatestUrl = (domain: string) =>
	`${UPSTREAM_HOST}/data_spatial/${domain}/latest.json`;

const upstreamMetaUrl = (domain: string, runPath: string) =>
	`${UPSTREAM_HOST}/data_spatial/${domain}/${runPath}/meta.json`;

const upstreamOmUrl = (domain: string, runPath: string, validTime: string) =>
	`${UPSTREAM_HOST}/data_spatial/${domain}/${runPath}/${validTime}.om`;

const r2LatestKey = (domain: string) => `data_spatial/${domain}/latest.json`;
const r2MetaKey = (domain: string) => `data_spatial/${domain}/meta.json`;
const r2OmKey = (domain: string, runPath: string, validTime: string) =>
	`data_spatial/${domain}/${runPath}/${validTime}.om`;

// Read R2-stored latest.json for a domain. Returns null if missing or invalid
// (cold bucket, corrupted write, etc). Callers should treat null as "we have
// no canonical run" — the proxy responds 503 in that case.
export const readR2Latest = async (
	env: Env,
	domain: string
): Promise<UpstreamLatest | null> => {
	try {
		const obj = await env.TILE_CACHE.get(r2LatestKey(domain));
		if (!obj) return null;
		const text = await obj.text();
		const parsed = JSON.parse(text) as UpstreamLatest;
		if (typeof parsed?.reference_time !== 'string') return null;
		return parsed;
	} catch {
		return null;
	}
};

// Stream-copy upstream .om body into R2. `head` check first avoids re-fetching
// files we've already warmed (idempotent ticks are safe).
// Returns 'not-yet-upstream' when upstream 404s — meaning the model run hasn't
// finished uploading that forecast hour yet. Callers use this as a signal to
// stop warming later hours (they'll also 404).
const warmOmFile = async (
	env: Env,
	domain: string,
	runPath: string,
	validTime: string
): Promise<'ok' | 'skip' | 'not-yet-upstream' | 'fail'> => {
	const key = r2OmKey(domain, runPath, validTime);
	try {
		const existing = await env.TILE_CACHE.head(key);
		if (existing) return 'skip';
		const url = upstreamOmUrl(domain, runPath, validTime);
		const res = await fetch(url);
		if (res.status === 404) {
			// Drain the body so the connection is reusable, then signal upstream-hole.
			await res.body?.cancel();
			return 'not-yet-upstream';
		}
		if (!res.ok || !res.body) return 'fail';
		await env.TILE_CACHE.put(key, res.body, {
			httpMetadata: {
				contentType: res.headers.get('content-type') ?? 'application/octet-stream'
			},
			customMetadata: {
				sourceUrl: url,
				refTime: runPath,
				cachedAt: new Date().toISOString()
			}
		});
		return 'ok';
	} catch (err) {
		console.warn('[warmer] file failed', key, err);
		return 'fail';
	}
};

// Bounded-concurrency parallel warm. Returns counters + flags.
// Shared 'stop' flag: on first 404, drain the queue so no new files are picked
// up. In-flight workers finish their current file; the slight overshoot is
// accepted to keep the code simple.
const warmAllFiles = async (
	env: Env,
	domain: string,
	runPath: string,
	validTimesIso: string[],
	deadline: number
): Promise<{
	ok: number;
	skip: number;
	fail: number;
	notYetUpstream: number;
	timedOut: boolean;
	stoppedAt404: boolean;
}> => {
	let ok = 0;
	let skip = 0;
	let fail = 0;
	let notYetUpstream = 0;
	let timedOut = false;
	let stoppedAt404 = false;
	const queue = [...validTimesIso]; // chronological order from meta.json
	const workers = Array.from({ length: OM_FILE_CONCURRENCY }, () =>
		(async () => {
			while (queue.length) {
				if (stoppedAt404) return;
				if (Date.now() > deadline) {
					timedOut = true;
					return;
				}
				const iso = queue.shift();
				if (!iso) return;
				const validTime = fmtValidTime(iso);
				const outcome = await warmOmFile(env, domain, runPath, validTime);
				if (outcome === 'ok') ok++;
				else if (outcome === 'skip') skip++;
				else if (outcome === 'not-yet-upstream') {
					notYetUpstream++;
					stoppedAt404 = true;
					// Drop remaining queue so other workers exit on next loop iteration.
					queue.length = 0;
				} else fail++;
			}
		})()
	);
	await Promise.all(workers);
	return { ok, skip, fail, notYetUpstream, timedOut, stoppedAt404 };
};

// List + delete all `.om` keys under `data_spatial/<domain>/` whose run-path
// segment isn't the one we just warmed. We scan in pages (list max 1000).
const deleteOldRunFiles = async (
	env: Env,
	domain: string,
	keepRunPath: string
): Promise<number> => {
	let cursor: string | undefined;
	let deleted = 0;
	const prefix = `data_spatial/${domain}/`;
	// Loop at most a few times — even a 384-hour forecast + retention history
	// shouldn't produce more than a few thousand keys per domain.
	for (let page = 0; page < 20; page++) {
		const listing = await env.TILE_CACHE.list({ prefix, cursor, limit: 1000 });
		const oldOmKeys: string[] = [];
		for (const obj of listing.objects) {
			if (!obj.key.endsWith('.om')) continue;
			// key: data_spatial/<domain>/<YYYY/MM/DD/HHmmZ>/<validTime>.om
			// Extract run path = segment between domain and the final filename.
			const parts = obj.key.slice(prefix.length).split('/');
			if (parts.length < 5) continue; // Not a run-path structured key — ignore.
			const runPath = parts.slice(0, 4).join('/');
			if (runPath !== keepRunPath) oldOmKeys.push(obj.key);
		}
		if (oldOmKeys.length) {
			// R2 batch delete: supports up to 1000 keys per call.
			await env.TILE_CACHE.delete(oldOmKeys);
			deleted += oldOmKeys.length;
		}
		if (!listing.truncated) break;
		cursor = (listing as { cursor?: string }).cursor;
		if (!cursor) break;
	}
	return deleted;
};

// Fetch upstream JSON, return parsed or null on any failure.
const fetchJson = async <T>(url: string): Promise<T | null> => {
	try {
		const res = await fetch(url);
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
};

export type DomainResult =
	| { domain: string; status: 'unchanged'; referenceTime: string }
	| { domain: string; status: 'no-upstream'; error: string }
	| {
			domain: string;
			status: 'warmed';
			referenceTime: string;
			previousReferenceTime: string | null;
			files: { ok: number; skip: number; fail: number; timedOut: boolean };
			deletedOldFiles: number;
			wallMs: number;
	  }
	| { domain: string; status: 'error'; error: string };

export const warmDomain = async (env: Env, domain: string): Promise<DomainResult> => {
	const t0 = Date.now();
	const deadline = t0 + PER_DOMAIN_TIMEOUT_MS;
	try {
		const upstream = await fetchJson<UpstreamLatest>(upstreamLatestUrl(domain));
		if (!upstream?.reference_time) {
			return { domain, status: 'no-upstream', error: 'latest.json missing reference_time' };
		}

		const ours = await readR2Latest(env, domain);
		if (ours?.reference_time === upstream.reference_time) {
			return { domain, status: 'unchanged', referenceTime: upstream.reference_time };
		}

		const newRunPath = fmtRunPath(upstream.reference_time);
		const meta = await fetchJson<UpstreamMeta>(upstreamMetaUrl(domain, newRunPath));
		if (!meta || !Array.isArray(meta.valid_times) || meta.valid_times.length === 0) {
			return {
				domain,
				status: 'error',
				error: `meta.json missing or empty for ${newRunPath}`
			};
		}

		// Cap at +72 h from reference_time. Kiters almost never look beyond that;
		// shorter-horizon models (HRRR 18 h) naturally land under the cap.
		const refTimeMs = new Date(upstream.reference_time).getTime();
		const cutoffMs = refTimeMs + MAX_HORIZON_HOURS * 3600 * 1000;
		const cappedValidTimes = meta.valid_times.filter(
			(iso) => new Date(iso).getTime() <= cutoffMs
		);

		// Warm the capped list. Upstream is chronological — on first 404 (model
		// run still uploading later hours) we stop; those files get picked up on
		// the next cron tick.
		const fileStats = await warmAllFiles(env, domain, newRunPath, cappedValidTimes, deadline);

		// If the warm timed out we stop BEFORE swapping latest.json — clients keep
		// seeing the old run (fully cached). The next cron tick resumes from the
		// remaining unfetched files (`head` skip makes this idempotent) and does
		// the swap when all files are in R2.
		if (fileStats.timedOut) {
			return {
				domain,
				status: 'error',
				error: `timed out mid-warm; ok=${fileStats.ok} skip=${fileStats.skip} fail=${fileStats.fail}`
			};
		}
		// Also bail if too many files failed — a partial run would give clients
		// broken 404s. Threshold: > 10% failed.
		if (fileStats.fail > 0 && fileStats.fail > Math.max(3, fileStats.ok * 0.1)) {
			return {
				domain,
				status: 'error',
				error: `too many file warms failed ok=${fileStats.ok} fail=${fileStats.fail}`
			};
		}
		// If we stopped early at an upstream 404, the run isn't fully uploaded
		// yet. We DON'T swap latest.json — users would otherwise see a run whose
		// tail hours 404. Next cron tick retries; `head` skips what we already
		// warmed so it's cheap.
		if (fileStats.stoppedAt404) {
			return {
				domain,
				status: 'error',
				error: `upstream run still uploading; warmed ${fileStats.ok} files before 404, will resume next tick`
			};
		}

		// Atomic swap: write meta.json first, then latest.json. Clients reading
		// latest.json have a consistent snapshot — when they see the new
		// reference_time they can immediately fetch meta.json for it.
		await env.TILE_CACHE.put(r2MetaKey(domain), JSON.stringify(meta), {
			httpMetadata: { contentType: 'application/json' },
			customMetadata: {
				refTime: upstream.reference_time,
				cachedAt: new Date().toISOString()
			}
		});
		await env.TILE_CACHE.put(r2LatestKey(domain), JSON.stringify(upstream), {
			httpMetadata: { contentType: 'application/json' },
			customMetadata: {
				refTime: upstream.reference_time,
				cachedAt: new Date().toISOString()
			}
		});

		// Cleanup: drop .om files from the previous run.
		const deletedOldFiles = await deleteOldRunFiles(env, domain, newRunPath);

		return {
			domain,
			status: 'warmed',
			referenceTime: upstream.reference_time,
			previousReferenceTime: ours?.reference_time ?? null,
			files: fileStats,
			deletedOldFiles,
			wallMs: Date.now() - t0
		};
	} catch (err) {
		return { domain, status: 'error', error: String(err) };
	}
};

// Warm every domain (sequential). Returns per-domain results AND persists a
// summary at `_warmer/last-run.json` so the `/tiles/_debug/cache` endpoint can
// surface when the cron last ticked without needing CF dashboard access.
export const warmAll = async (env: Env): Promise<DomainResult[]> => {
	const startedAt = new Date().toISOString();
	const t0 = Date.now();
	const results: DomainResult[] = [];
	for (const domain of WARMED_DOMAINS) {
		results.push(await warmDomain(env, domain));
	}
	const summary = {
		startedAt,
		finishedAt: new Date().toISOString(),
		wallMs: Date.now() - t0,
		byStatus: results.reduce<Record<string, number>>((acc, r) => {
			acc[r.status] = (acc[r.status] ?? 0) + 1;
			return acc;
		}, {}),
		results
	};
	try {
		await env.TILE_CACHE.put('_warmer/last-run.json', JSON.stringify(summary), {
			httpMetadata: { contentType: 'application/json' },
			customMetadata: { ranAt: startedAt }
		});
	} catch (err) {
		console.warn('[warmer] failed to persist last-run.json', err);
	}
	return results;
};
