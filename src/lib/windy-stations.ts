// Render live wind station data from the Windy Stations API (via Surfr backend proxy)
// as Windy-style pill markers: colored capsule with direction arrow + speed number.
// Uses DOM markers (MapLibre Marker API) for proper pill rendering.

import { Marker } from 'maplibre-gl';
import type * as maplibregl from 'maplibre-gl';

const MIN_ZOOM = 5;
const LIMIT = 200;
const DEBOUNCE_MS = 700;

type WindyStation = {
	id: string;
	name: string;
	lat: number;
	lon: number;
	windKts: number | null;
	windDir: number | null;
	gustKts: number | null;
	updatedAt: number | null;
	source: string | null;
};

type WindyStationsConfig = {
	endpoint?: string;
	visible?: boolean;
	onStationTap?: (station: WindyStation) => void;
};

// Surfr embed wind color anchors [kt, r, g, b]
const COLOR_ANCHORS: [number, number, number, number][] = [
	[0, 64, 89, 153],
	[8, 110, 221, 235],
	[12, 82, 204, 122],
	[15, 153, 230, 68],
	[20, 245, 255, 47],
	[25, 255, 185, 53],
	[30, 255, 118, 82],
	[35, 255, 82, 173],
	[40, 255, 88, 235],
	[50, 173, 112, 255],
];

const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

function windColor(kts: number): string {
	if (kts <= COLOR_ANCHORS[0][0]) {
		const [, r, g, b] = COLOR_ANCHORS[0];
		return `rgb(${r},${g},${b})`;
	}
	for (let i = 0; i < COLOR_ANCHORS.length - 1; i++) {
		const [k0, r0, g0, b0] = COLOR_ANCHORS[i];
		const [k1, r1, g1, b1] = COLOR_ANCHORS[i + 1];
		if (kts >= k0 && kts < k1) {
			const t = (kts - k0) / (k1 - k0);
			return `rgb(${lerp(r0, r1, t)},${lerp(g0, g1, t)},${lerp(b0, b1, t)})`;
		}
	}
	const last = COLOR_ANCHORS[COLOR_ANCHORS.length - 1];
	return `rgb(${last[1]},${last[2]},${last[3]})`;
}

function textColor(kts: number): string {
	return kts >= 20 && kts < 30 ? '#1a1a2e' : '#ffffff';
}

// SVG arrow pointing up (will be rotated by wind direction)
function arrowSvg(dir: number, color: string): string {
	// Wind direction is "from" — rotate to point downwind (+180°)
	const rotation = (dir + 180) % 360;
	return `<svg width="10" height="10" viewBox="0 0 10 10" style="transform:rotate(${rotation}deg)">` +
		`<polygon points="5,1 9,8 5,6 1,8" fill="${color}"/></svg>`;
}

function verifiedSvg(): string {
	return `<svg width="10" height="10" viewBox="0 0 10 10" style="flex-shrink:0">` +
		`<circle cx="5" cy="5" r="4.5" fill="#4ADE80"/>` +
		`<path d="M3 5.2 L4.3 6.5 L7 3.8" stroke="#fff" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function createPillElement(station: WindyStation): HTMLDivElement {
	const kts = Math.round(station.windKts ?? 0);
	const bg = windColor(kts);
	const fg = textColor(kts);
	const dir = station.windDir ?? 0;
	const isVerified = station.source != null && station.source !== 'pws';

	const el = document.createElement('div');
	el.className = 'ws-pill';
	el.style.cssText =
		`display:inline-flex;align-items:center;gap:2px;` +
		`background:${bg};color:${fg};` +
		`padding:3px 6px 3px 4px;border-radius:10px;` +
		`font:700 11px/1 system-ui,-apple-system,sans-serif;` +
		`white-space:nowrap;cursor:pointer;` +
		`border:1px solid rgba(255,255,255,0.35);` +
		`box-shadow:0 1px 3px rgba(0,0,0,0.4);` +
		`pointer-events:auto;user-select:none;`;

	el.innerHTML = arrowSvg(dir, fg) + `<span>${kts}</span>` + (isVerified ? verifiedSvg() : '');
	return el;
}

let currentMap: maplibregl.Map | null = null;
let currentConfig: WindyStationsConfig = {};
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let pendingAbort: AbortController | undefined;
let activeMarkers: Marker[] = [];
let lastStations: WindyStation[] = [];

const removeAllMarkers = () => {
	for (const m of activeMarkers) m.remove();
	activeMarkers = [];
};

const renderMarkers = (map: maplibregl.Map, stations: WindyStation[]) => {
	removeAllMarkers();
	lastStations = stations;
	for (const s of stations) {
		if (s.windKts == null) continue;
		const el = createPillElement(s);
		el.addEventListener('click', (e) => {
			e.stopPropagation();
			currentConfig.onStationTap?.(s);
		});
		const marker = new Marker({ element: el, anchor: 'center' })
			.setLngLat([s.lon, s.lat])
			.addTo(map);
		activeMarkers.push(marker);
	}
};

const fetchAndRender = async (map: maplibregl.Map, config: WindyStationsConfig): Promise<void> => {
	if (!config.endpoint || !config.visible) return;
	if (map.getZoom() < MIN_ZOOM) {
		removeAllMarkers();
		return;
	}
	const bounds = map.getBounds();
	const url =
		`${config.endpoint.replace(/\/$/, '')}/windystations/bbox` +
		`?minlat=${bounds.getSouth()}` +
		`&maxlat=${bounds.getNorth()}` +
		`&minlon=${bounds.getWest()}` +
		`&maxlon=${bounds.getEast()}` +
		`&limit=${LIMIT}`;

	pendingAbort?.abort();
	pendingAbort = new AbortController();
	try {
		const res = await fetch(url, { signal: pendingAbort.signal });
		if (!res.ok) return;
		const stations = (await res.json()) as WindyStation[];
		if (!Array.isArray(stations)) return;
		renderMarkers(map, stations);
	} catch (e) {
		if ((e as Error).name === 'AbortError') return;
		console.warn('[windy-stations] fetch failed', e);
	}
};

const debounced = (map: maplibregl.Map) => {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => fetchAndRender(map, currentConfig), DEBOUNCE_MS);
};

const onMoveEnd = (): void => {
	if (currentMap && currentConfig.visible) debounced(currentMap);
};

export const initWindyStations = (map: maplibregl.Map): void => {
	currentMap = map;
	map.on('moveend', onMoveEnd);
};

export const setWindyStationsConfig = (config: WindyStationsConfig): void => {
	currentConfig = { ...currentConfig, ...config };
	if (currentMap && currentConfig.visible) fetchAndRender(currentMap, currentConfig);
};

export const setWindyStationsVisible = (map: maplibregl.Map, visible: boolean): void => {
	currentConfig.visible = visible;
	if (visible && currentMap) {
		fetchAndRender(currentMap, currentConfig);
	} else {
		removeAllMarkers();
	}
};

export const teardownWindyStations = (map: maplibregl.Map): void => {
	map.off('moveend', onMoveEnd);
	pendingAbort?.abort();
	pendingAbort = undefined;
	if (debounceTimer) {
		clearTimeout(debounceTimer);
		debounceTimer = undefined;
	}
	removeAllMarkers();
	currentMap = null;
};
