// HTML admin overview — `/tiles/_admin`.
//
// Per model shows:
//   - Our R2 latest.json reference_time (= what we serve)
//   - Our R2 meta.json reference_time (should match — mismatch = mid-swap)
//   - Upstream latest.json reference_time (fetched live — shows if we're behind)
//   - # of .om files in R2 for the current run + total MB
//   - Oldest / newest valid_time we have cached
// Plus: when the cron last ran (from `_warmer/last-run.json`).
//
// No auth — same reasoning as _warmer-trigger. Readonly anyway.

import { WARMED_DOMAINS } from '../lib/domains';

interface Env {
	TILE_CACHE: R2Bucket;
}

const UPSTREAM_HOST = 'https://map-tiles.open-meteo.com';

type DomainRow = {
	domain: string;
	r2Latest: string | null;
	r2Meta: string | null;
	upstreamLatest: string | null;
	upstreamError: string | null;
	fileCount: number;
	totalMb: number;
	oldestValid: string | null;
	newestValid: string | null;
	runPath: string | null;
	status: 'ok' | 'stale' | 'cold' | 'unknown';
};

const fmtRunPath = (isoRefTime: string): string => {
	const d = new Date(isoRefTime);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
};

const readJsonRefTime = async (
	bucket: R2Bucket,
	key: string
): Promise<string | null> => {
	try {
		const obj = await bucket.get(key);
		if (!obj) return null;
		const parsed = JSON.parse(await obj.text()) as { reference_time?: string };
		return parsed.reference_time ?? null;
	} catch {
		return null;
	}
};

const fetchUpstreamLatest = async (domain: string): Promise<string | null> => {
	try {
		const res = await fetch(`${UPSTREAM_HOST}/data_spatial/${domain}/latest.json`);
		if (!res.ok) return null;
		const parsed = (await res.json()) as { reference_time?: string };
		return parsed.reference_time ?? null;
	} catch {
		return null;
	}
};

const listDomainFiles = async (
	bucket: R2Bucket,
	domain: string,
	runPath: string
): Promise<{ count: number; totalBytes: number; oldest: string | null; newest: string | null }> => {
	const prefix = `data_spatial/${domain}/${runPath}/`;
	let cursor: string | undefined;
	let count = 0;
	let totalBytes = 0;
	let oldest: string | null = null;
	let newest: string | null = null;
	for (let page = 0; page < 20; page++) {
		const listing = await bucket.list({ prefix, cursor, limit: 1000 });
		for (const obj of listing.objects) {
			if (!obj.key.endsWith('.om')) continue;
			count++;
			totalBytes += obj.size;
			// Key tail is "<validTime>.om" — pull out validTime.
			const tail = obj.key.slice(prefix.length).replace(/\.om$/, '');
			if (!oldest || tail < oldest) oldest = tail;
			if (!newest || tail > newest) newest = tail;
		}
		if (!listing.truncated) break;
		cursor = (listing as { cursor?: string }).cursor;
		if (!cursor) break;
	}
	return { count, totalBytes, oldest, newest };
};

const collectRow = async (bucket: R2Bucket, domain: string): Promise<DomainRow> => {
	const [r2Latest, r2Meta, upstreamLatest] = await Promise.all([
		readJsonRefTime(bucket, `data_spatial/${domain}/latest.json`),
		readJsonRefTime(bucket, `data_spatial/${domain}/meta.json`),
		fetchUpstreamLatest(domain)
	]);

	let fileCount = 0;
	let totalMb = 0;
	let oldest: string | null = null;
	let newest: string | null = null;
	let runPath: string | null = null;

	if (r2Latest) {
		runPath = fmtRunPath(r2Latest);
		const listing = await listDomainFiles(bucket, domain, runPath);
		fileCount = listing.count;
		totalMb = +(listing.totalBytes / 1e6).toFixed(1);
		oldest = listing.oldest;
		newest = listing.newest;
	}

	let status: DomainRow['status'] = 'unknown';
	if (!r2Latest) status = 'cold';
	else if (!upstreamLatest) status = 'unknown';
	else if (r2Latest === upstreamLatest) status = 'ok';
	else status = 'stale';

	return {
		domain,
		r2Latest,
		r2Meta,
		upstreamLatest,
		upstreamError: null,
		fileCount,
		totalMb,
		oldestValid: oldest,
		newestValid: newest,
		runPath,
		status
	};
};

const STATUS_COLORS = {
	ok: '#16a34a',
	stale: '#f59e0b',
	cold: '#ef4444',
	unknown: '#6b7280'
};

const escapeHtml = (v: string | null | undefined): string => {
	if (v == null) return '—';
	return String(v)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
};

const renderHtml = (rows: DomainRow[], lastCron: unknown): string => {
	const rowsHtml = rows
		.map((r) => {
			const color = STATUS_COLORS[r.status];
			const statusPill = `<span style="background:${color};color:white;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">${r.status.toUpperCase()}</span>`;
			const mismatch =
				r.r2Latest && r.upstreamLatest && r.r2Latest !== r.upstreamLatest
					? `<br><span style="color:#f59e0b;font-size:11px">Upstream: ${escapeHtml(r.upstreamLatest)}</span>`
					: '';
			const metaMismatch =
				r.r2Latest && r.r2Meta && r.r2Latest !== r.r2Meta
					? `<br><span style="color:#ef4444;font-size:11px">meta.json out of sync: ${escapeHtml(r.r2Meta)}</span>`
					: '';
			return `<tr>
				<td><strong>${escapeHtml(r.domain)}</strong></td>
				<td>${statusPill}</td>
				<td><code>${escapeHtml(r.r2Latest)}</code>${mismatch}${metaMismatch}</td>
				<td style="text-align:right">${r.fileCount}</td>
				<td style="text-align:right">${r.totalMb.toFixed(1)}&nbsp;MB</td>
				<td><code>${escapeHtml(r.oldestValid)}</code></td>
				<td><code>${escapeHtml(r.newestValid)}</code></td>
			</tr>`;
		})
		.join('');

	const totalMb = rows.reduce((s, r) => s + r.totalMb, 0);
	const totalFiles = rows.reduce((s, r) => s + r.fileCount, 0);
	const cronDetails = lastCron
		? `<details><summary>Last cron: ${escapeHtml(
				(lastCron as { finishedAt?: string }).finishedAt ??
					(lastCron as { startedAt?: string }).startedAt ??
					'?'
			)} (${escapeHtml(
				JSON.stringify((lastCron as { byStatus?: unknown }).byStatus ?? {})
			)})</summary><pre style="background:#0b0b0f;color:#d1d5db;padding:12px;border-radius:6px;overflow:auto;font-size:12px">${escapeHtml(
				JSON.stringify(lastCron, null, 2)
			)}</pre></details>`
		: `<p style="color:#ef4444">No cron has run yet.</p>`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Surfr tile cache admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
	body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111; background: #f5f5f7; margin: 0; padding: 24px; }
	h1 { margin: 0 0 4px; font-size: 20px; }
	.sub { color: #6b7280; margin-bottom: 20px; }
	.totals { margin: 12px 0 20px; color: #374151; }
	.totals strong { color: #111; }
	table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.05); }
	th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
	th { background: #fafafa; color: #6b7280; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
	tr:last-child td { border-bottom: none; }
	code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; font-size: 11px; color: #111; }
	details { margin: 16px 0; }
	summary { cursor: pointer; font-weight: 600; padding: 8px 0; }
	.legend { margin: 8px 0 16px; font-size: 11px; color: #6b7280; }
	.legend span { padding: 2px 8px; border-radius: 10px; color: white; font-weight: 600; margin-right: 6px; }
	.actions { margin: 16px 0; font-size: 12px; }
	.actions a { background: #111; color: white; padding: 6px 12px; border-radius: 6px; text-decoration: none; margin-right: 8px; }
	.actions a:hover { background: #374151; }
</style>
</head>
<body>
<h1>Surfr tile cache</h1>
<div class="sub">Generated ${new Date().toISOString()}</div>
${cronDetails}
<div class="legend">
	<span style="background:#16a34a">OK</span>warmed &amp; current
	<span style="background:#f59e0b">STALE</span>upstream has newer run
	<span style="background:#ef4444">COLD</span>never warmed
	<span style="background:#6b7280">UNKNOWN</span>upstream unreachable
</div>
<div class="totals"><strong>${totalFiles}</strong> files &middot; <strong>${totalMb.toFixed(1)} MB</strong> across ${rows.length} domains</div>
<div class="actions">
	<a href="/tiles/_warmer-trigger?wait=1">Trigger warmer (wait for result)</a>
	<a href="/tiles/_warmer-trigger">Trigger warmer (async)</a>
	<a href="/tiles/_debug/cache">JSON inventory</a>
</div>
<table>
<thead>
<tr>
	<th>Domain</th>
	<th>Status</th>
	<th>Reference time (our R2)</th>
	<th>Files</th>
	<th>Size</th>
	<th>Oldest valid</th>
	<th>Newest valid</th>
</tr>
</thead>
<tbody>${rowsHtml}</tbody>
</table>
</body>
</html>`;
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
	const rows = await Promise.all(
		WARMED_DOMAINS.map((d) => collectRow(context.env.TILE_CACHE, d))
	);

	let lastCron: unknown = null;
	try {
		const obj = await context.env.TILE_CACHE.get('_warmer/last-run.json');
		if (obj) lastCron = JSON.parse(await obj.text());
	} catch {
		/* noop */
	}

	return new Response(renderHtml(rows, lastCron), {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store'
		}
	});
};
