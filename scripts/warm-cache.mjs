#!/usr/bin/env node
/**
 * Cache warmer for our CF Pages Function tile proxy.
 *
 * Design (see plan file / redesign in the conversation):
 *   1. `.om` URLs are immutable per (domain, reference_time, forecast_time).
 *   2. The only thing that moves is `latest.json` — its `reference_time` field
 *      flips when Open-Meteo publishes a new model run.
 *   3. Therefore we only need to warm a domain's URLs when its reference_time
 *      changes. Unchanged → noop.
 *
 * Loop per run:
 *   for each domain:
 *     directLatest = fetch upstream latest.json   (bypass our proxy → truth)
 *     if directLatest.reference_time !== state.last[domain]:
 *       warm ALL .om URLs for the new run (next HOURS_AHEAD h)
 *       THEN force-refresh our proxy's latest.json   (atomic swap — clients
 *         stop seeing the old reference_time only after new URLs are warm)
 *       state.last[domain] = directLatest.reference_time
 *     else:
 *       log noop
 *
 * State file: scripts/warmer-state.json — gitignored, created on first run.
 *
 * Usage:
 *   node scripts/warm-cache.mjs                             # normal
 *   node scripts/warm-cache.mjs --domains=dwd_icon_eu       # subset
 *   node scripts/warm-cache.mjs --hours=72 --concurrency=8
 *   node scripts/warm-cache.mjs --force                     # ignore state; warm every domain
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(__dirname, 'warmer-state.json');

const PROXY_BASE = 'https://maps.thesurfr.app/tiles';
const UPSTREAM_BASE = 'https://map-tiles.open-meteo.com';

// Map-tile domain names (canonical list in @openmeteo/weather-map-layer/src/domains.ts),
// aligned to the frontend's FORECAST_MODELS catalog.
const DEFAULT_DOMAINS = [
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
	// GFS: frontend uses 0.13° for wind/rain and 0.25° for gusts — warm both.
	'ncep_gfs013',
	'ncep_gfs025'
];

// ─── CLI ─────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const [k, v = true] = a.replace(/^--/, '').split('=');
		return [k, v];
	})
);
const HOURS_AHEAD = Number(args.hours ?? 72);
const CONCURRENCY = Number(args.concurrency ?? 8);
const DOMAINS = args.domains ? String(args.domains).split(',') : DEFAULT_DOMAINS;
// IMPORTANT: do NOT send a Range header. CF with cacheEverything caches per-range.
// A Range warm only caches that slice; the library's first request is always the
// file FOOTER (last 64KB) which would still be a miss. A full GET forces CF to
// download + cache the entire file (~34–110 MB), after which ANY range is instant.
const FULL_GET = true;
const FORCE = args.force === true || args.force === 'true';

// ─── State helpers ───────────────────────────────────────────────────────────
function loadState() {
	if (!existsSync(STATE_PATH)) return {};
	try {
		return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
	} catch {
		return {};
	}
}

function saveState(state) {
	mkdirSync(dirname(STATE_PATH), { recursive: true });
	writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ─── Time format helpers (mirror fork's url.ts) ──────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const fmtModelRun = (iso) => {
	const d = new Date(iso);
	return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
};
const fmtValidTime = (iso) => {
	const d = new Date(iso);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
};

// ─── Per-domain check + warm ────────────────────────────────────────────────
async function processDomain(domain, state) {
	const t0 = performance.now();
	const stats = {
		domain,
		action: 'noop',
		referenceTime: null,
		filesOk: 0,
		filesFailed: 0,
		filesSlow: 0,
		totalBytes: 0,
		avgMs: 0,
		wallMs: 0,
		error: null
	};
	try {
		// 1. UPSTREAM latest.json — bypass our proxy so we see the real truth.
		const latestRes = await fetch(`${UPSTREAM_BASE}/data_spatial/${domain}/latest.json`);
		if (!latestRes.ok) throw new Error(`upstream latest.json ${latestRes.status}`);
		const latest = await latestRes.json();
		const refTime = latest.reference_time;
		if (!refTime) throw new Error('no reference_time');
		stats.referenceTime = refTime;

		const lastKnown = state[domain]?.referenceTime;
		if (!FORCE && lastKnown === refTime) {
			stats.action = 'noop';
			return stats;
		}

		stats.action = FORCE ? 'forced' : lastKnown ? 'new-run' : 'first-run';

		// 2. meta.json for that run (through our proxy — this also primes the cache).
		const runPath = fmtModelRun(refTime);
		const metaRes = await fetch(
			`${PROXY_BASE}/data_spatial/${domain}/${runPath}/meta.json`
		);
		if (!metaRes.ok) throw new Error(`proxy meta.json ${metaRes.status}`);
		const meta = await metaRes.json();
		const allTimes = meta.valid_times ?? [];

		const now = Date.now();
		const cutoff = now + HOURS_AHEAD * 3600 * 1000;
		const targets = allTimes.filter((t) => {
			const ms = new Date(t).getTime();
			return ms >= now - 3600 * 1000 && ms <= cutoff; // include the slot we're currently in
		});

		// 3. Warm .om files for the new run.
		const queue = [...targets];
		let totalMs = 0;
		const workers = Array.from({ length: CONCURRENCY }, () =>
			(async () => {
				while (queue.length) {
					const validTime = queue.shift();
					if (!validTime) return;
					const url = `${PROXY_BASE}/data_spatial/${domain}/${runPath}/${fmtValidTime(validTime)}.om`;
					const req = performance.now();
					try {
						const res = await fetch(url, FULL_GET ? {} : { headers: { Range: 'bytes=0-65535' } });
						const ms = performance.now() - req;
						totalMs += ms;
						if (!res.ok && res.status !== 206) {
							stats.filesFailed++;
							continue;
						}
						const buf = await res.arrayBuffer();
						stats.totalBytes += buf.byteLength;
						stats.filesOk++;
						if (ms > 1000) stats.filesSlow++;
					} catch {
						stats.filesFailed++;
					}
				}
			})()
		);
		await Promise.all(workers);
		stats.avgMs = stats.filesOk ? Math.round(totalMs / stats.filesOk) : 0;

		// 4. ATOMIC SWAP: force-refresh our proxy's latest.json so clients start
		//    seeing the new reference_time only now — AFTER the new run's .om
		//    URLs are all warm. Clients that fetched latest.json during the warm
		//    phase still have the old reference_time in their app state.
		await fetch(`${PROXY_BASE}/data_spatial/${domain}/latest.json`, {
			headers: { 'X-Surfr-Force-Refresh': '1' }
		}).catch(() => {});

		// 5. Persist state
		state[domain] = { referenceTime: refTime, warmedAt: new Date().toISOString() };
	} catch (e) {
		stats.error = e.message;
	}
	stats.wallMs = performance.now() - t0;
	return stats;
}

// ─── Run ─────────────────────────────────────────────────────────────────────
const state = loadState();
console.log(
	`Warmer pass — ${DOMAINS.length} domains, next ${HOURS_AHEAD} h, concurrency=${CONCURRENCY}${FORCE ? ' [FORCE]' : ''}\n`
);
const startAll = performance.now();
const results = [];
for (const d of DOMAINS) {
	process.stdout.write(`  ${d.padEnd(38)} `);
	const r = await processDomain(d, state);
	results.push(r);
	if (r.error) {
		console.log(`✗ ${r.error}`);
	} else if (r.action === 'noop') {
		console.log(`noop (ref ${r.referenceTime})`);
	} else {
		const mb = (r.totalBytes / 1e6).toFixed(1);
		console.log(
			`${r.action} ref ${r.referenceTime} — ${r.filesOk} ok / ${r.filesFailed} failed, ${r.filesSlow} slow, avg ${r.avgMs} ms, ${mb} MB, wall ${(r.wallMs / 1000).toFixed(1)} s`
		);
	}
}
saveState(state);

const totalWallS = ((performance.now() - startAll) / 1000).toFixed(1);
const warmed = results.filter((r) => r.action !== 'noop' && !r.error).length;
const errors = results.filter((r) => r.error).length;
console.log(
	`\nDone. ${warmed}/${results.length} domains warmed, ${errors} errors, wall ${totalWallS} s.`
);
