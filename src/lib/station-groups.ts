// Station groups (the stacked-badge nodes) — which stations a node stands for,
// so a tap can fit the map to them (SRF-3044).
//
// The live-cluster carries each node's cell id (`c-z<grid>-<x>-<y>`) but not its
// members. A station belongs to the node whose Web-Mercator tile at the node's
// grid zoom contains it — the same math the live-wind service uses to build the
// nodes (surfr-live-wind layer/build.ts `cellId`), so recomputing it here gives
// the exact member set without shipping member lists in the file.

type Position = { lat: number; lon: number };

const MAX_LAT = 85.05112878;

/** Web-Mercator tile x/y at `zoom` — identical to the live-wind service's. */
const latLonToTile = (lat: number, lon: number, zoom: number): [number, number] => {
	const n = 1 << zoom;
	const x = Math.floor(((lon + 180) / 360) * n);
	const latRad = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
	const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
	return [Math.max(0, Math.min(x, n - 1)), Math.max(0, Math.min(y, n - 1))];
};

/** Node cell id for a station at a grid tier, e.g. "c-z8-134-81". */
export const cellId = (lat: number, lon: number, grid: number): string => {
	const [x, y] = latLonToTile(lat, lon, grid);
	return `c-z${grid}-${x}-${y}`;
};

/**
 * [[west, south], [east, north]] around the stations in a node's cell, or null
 * when none of the known positions fall in it (legacy ungridded nodes, or a
 * node newer than the positions on screen).
 */
export const groupBounds = (
	nodeId: string,
	grid: number,
	positions: Iterable<Position>
): [[number, number], [number, number]] | null => {
	let west = Infinity;
	let south = Infinity;
	let east = -Infinity;
	let north = -Infinity;
	for (const p of positions) {
		if (cellId(p.lat, p.lon, grid) !== nodeId) continue;
		west = Math.min(west, p.lon);
		east = Math.max(east, p.lon);
		south = Math.min(south, p.lat);
		north = Math.max(north, p.lat);
	}
	return west === Infinity
		? null
		: [
				[west, south],
				[east, north]
			];
};

/**
 * Zoom to land on after a group tap: the zoom that fits its stations, but at
 * least just past the node's expansion zoom (so the next tier, or the
 * individual stations, are the ones on screen) and no closer than `maxZoom`
 * (a tight pair shouldn't land at street level).
 */
export const groupTapZoom = (
	fitZoom: number | undefined,
	expansionZoom: number,
	maxZoom: number
): number => {
	const minZoom = expansionZoom + 0.01;
	if (fitZoom == null || !Number.isFinite(fitZoom)) return minZoom;
	return Math.min(Math.max(fitZoom, minZoom), Math.max(maxZoom, minZoom));
};
