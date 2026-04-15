#!/usr/bin/env node
/**
 * Cache warmer for our CF Pages Function tile proxy.
 *
 * For each map-tile domain:
 *   1. GET latest.json        → reference_time
 *   2. GET {run}/meta.json    → valid_times[]
 *   3. Filter valid_times to now..now+Nh
 *   4. Concurrent GETs (Range: bytes=0-65535) for each (domain, time)
 *
 * Empirically, one small range-GET warms CF's edge for that file;
 * subsequent range reads to any byte offset in the same file serve
 * ~140 ms through our proxy.
 *
 * Usage:  node scripts/warm-cache.mjs [--hours=72] [--concurrency=8] [--domains=dwd_icon,dwd_icon_eu]
 */

const PROXY_BASE = 'https://maps.thesurfr.app/tiles';

// Map-tile domain names (from @openmeteo/weather-map-layer/src/domains.ts) mapped
// to the frontend's FORECAST_MODELS catalog.
const DEFAULT_DOMAINS = [
	'metno_nordic_pp', // MET Nordic 1km
	'meteofrance_arome_france_hd', // Arome-HD 1.3km
	'dwd_icon_d2', // ICON-D2 2km
	'knmi_harmonie_arome_netherlands', // KNMI NL 2km
	'ukmo_uk_deterministic_2km', // UKV 2km
	'meteofrance_arome_france0025', // Arome 2.5km
	'cmc_gem_hrdps', // GEM HRDPS 2.5km
	'ncep_hrrr_conus', // HRRR 3km
	'knmi_harmonie_arome_europe', // HARMONIE 5.5km
	'dwd_icon_eu', // ICON-EU 7km
	'ecmwf_ifs025', // ECMWF 9km
	'dwd_icon', // ICON 11km
	'ncep_gfs013' // GFS 13km
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
const RANGE_HEADER = 'bytes=0-65535'; // ~64 KB probe per file
// --force-refresh: tells our Pages Function to evict + repopulate each URL's
// edge cache entry via the `X-Surfr-Force-Refresh: 1` header. Used on the 6-hourly
// cron aligned with Open-Meteo model-run publishes (00/06/12/18 UTC + 15 min).
const FORCE_REFRESH = args['force-refresh'] === true || args['force-refresh'] === 'true';

// ─── Helpers ─────────────────────────────────────────────────────────────────
const fmtModelRun = (iso) => {
	const d = new Date(iso);
	const pad = (n) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
};

const fmtValidTime = (iso) => {
	const d = new Date(iso);
	const pad = (n) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
};

const now = Date.now();
const cutoff = now + HOURS_AHEAD * 3600 * 1000;

async function probeDomain(domain) {
	const t0 = performance.now();
	const stats = {
		domain,
		filesAttempted: 0,
		filesOk: 0,
		filesSlow: 0, // > 1s TTFB (= upstream cold miss)
		filesFailed: 0,
		totalBytes: 0,
		totalMs: 0,
		error: null
	};
	try {
		// 1. latest.json
		const latestRes = await fetch(`${PROXY_BASE}/data_spatial/${domain}/latest.json`);
		if (!latestRes.ok) throw new Error(`latest.json ${latestRes.status}`);
		const latest = await latestRes.json();
		const refTime = latest.reference_time;
		if (!refTime) throw new Error('no reference_time');

		// 2. meta.json for that run
		const runPath = fmtModelRun(refTime);
		const metaRes = await fetch(`${PROXY_BASE}/data_spatial/${domain}/${runPath}/meta.json`);
		if (!metaRes.ok) throw new Error(`meta.json ${metaRes.status}`);
		const meta = await metaRes.json();
		const allTimes = meta.valid_times ?? [];
		const targets = allTimes.filter((t) => {
			const ms = new Date(t).getTime();
			return ms >= now && ms <= cutoff;
		});

		// 3. Parallel warm-up with bounded concurrency
		const queue = [...targets];
		const requestHeaders = { Range: RANGE_HEADER };
		if (FORCE_REFRESH) requestHeaders['X-Surfr-Force-Refresh'] = '1';
		const workers = Array.from({ length: CONCURRENCY }, () =>
			(async () => {
				while (queue.length) {
					const validTime = queue.shift();
					if (!validTime) return;
					const url = `${PROXY_BASE}/data_spatial/${domain}/${runPath}/${fmtValidTime(validTime)}.om`;
					const req = performance.now();
					try {
						const res = await fetch(url, { headers: requestHeaders });
						const ms = performance.now() - req;
						stats.filesAttempted++;
						stats.totalMs += ms;
						if (!res.ok && res.status !== 206) {
							stats.filesFailed++;
							continue;
						}
						const buf = await res.arrayBuffer();
						stats.totalBytes += buf.byteLength;
						stats.filesOk++;
						if (ms > 1000) stats.filesSlow++;
					} catch (e) {
						stats.filesAttempted++;
						stats.filesFailed++;
					}
				}
			})()
		);
		await Promise.all(workers);
	} catch (e) {
		stats.error = e.message;
	}
	stats.wallMs = performance.now() - t0;
	return stats;
}

// ─── Run ─────────────────────────────────────────────────────────────────────
console.log(
	`${FORCE_REFRESH ? 'Force-refreshing' : 'Warming'} ${DOMAINS.length} domains × next ${HOURS_AHEAD}h (concurrency=${CONCURRENCY})\n`
);
const startAll = performance.now();
const results = [];
for (const d of DOMAINS) {
	process.stdout.write(`  ${d.padEnd(38)} `);
	const r = await probeDomain(d);
	results.push(r);
	if (r.error) {
		console.log(`✗ ${r.error}`);
	} else {
		const avgMs = r.filesOk ? Math.round(r.totalMs / r.filesOk) : 0;
		const mb = (r.totalBytes / 1e6).toFixed(1);
		const wallS = (r.wallMs / 1000).toFixed(1);
		console.log(
			`${r.filesOk}/${r.filesAttempted} ok, ${r.filesSlow} slow, avg ${avgMs}ms, ${mb} MB, wall ${wallS}s`
		);
	}
}
const totalWallS = ((performance.now() - startAll) / 1000).toFixed(1);
const totalOk = results.reduce((s, r) => s + r.filesOk, 0);
const totalFailed = results.reduce((s, r) => s + r.filesFailed, 0);
const totalMB = (results.reduce((s, r) => s + r.totalBytes, 0) / 1e6).toFixed(1);
console.log(
	`\nTotal: ${totalOk} ok, ${totalFailed} failed, ${totalMB} MB, wall ${totalWallS}s`
);
