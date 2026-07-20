// Live wind stations — two-phase loading (SRF-2644).
//
// Phase 1 (paint): one static "live-cluster" file — all active station
// positions plus pre-clustered z8-grid nodes, generated nightly by the
// backend (SRF-2643) and served same-origin via the /stations/* Pages
// Function (Cloudflare edge cache in front of the public GCS bucket).
// Cached hard by the browser, so a repeat map open paints with zero
// station-related network requests.
//
// Phase 2 (hydrate): a small readings file every ~5 minutes — id-keyed live
// values + per-node max-wind aggregates. Applied via setFeatureState, so
// cluster/dot colors repaint without re-parsing, re-clustering, or symbol
// re-layout. Stations absent from the readings render dimmed (absence IS the
// staleness signal). Individual pills/arrows (z8+) rebuild from a second,
// small GeoJSON source containing only stations with a current reading.
//
// One rendering switch at z8 (same shape as spots, without spots' data swap):
//   z0–7.99  cluster nodes (circle layer, color = live max wind)
//   z8+      individual stations (Marijn's pill + arrow + badge design)
// MapLibre's own clustering is NOT used — nodes are pre-baked server-side
// with stable cell ids and a baked expansionZoom for drill-down.
//
// No per-pan or per-zoom fetching. /windystations/bbox has left the map
// path entirely; it remains only for tap details (names live there — the
// live-cluster carries none) and search.
//
// API surface preserved: initWindyStations, setWindyStationsConfig,
// setWindyStationsVisible, teardownWindyStations + the LAYER_ID_* exports
// rn-bridge consumes.
import type * as maplibregl from 'maplibre-gl';

const SOURCE_BASE = 'windy-stations-base'; // live-cluster: nodes + all stations
const SOURCE_LIVE = 'windy-stations'; // stations with a current reading (pills)

export const LAYER_ID_NODES = 'windy-stations-nodes';
export const LAYER_ID_DOTS = 'windy-stations-dots';
export const LAYER_ID_SELECTION_PILL = 'windy-stations-selection-pill';
export const LAYER_ID_PILL = 'windy-stations-pill';
export const LAYER_ID_ARROW = 'windy-stations-arrow';
export const LAYER_ID_VERIFIED = 'windy-stations-verified';

const ARROW_IMAGE_ID = 'windy-station-arrow';
const ARROW_IMAGE_ID_DARK = 'windy-station-arrow-dark';
const PILL_IMAGE_PREFIX = 'windy-station-pill-';
const SELECTION_PILL_IMAGE_ID = 'windy-station-selection-pill';
const VERIFIED_IMAGE_ID = 'windy-station-verified';

// Same-origin default — the /stations/* Pages Function proxies + edge-caches
// the public GCS objects. Overridable via setWindyStationsConfig for dev.
const DEFAULT_STATIONS_BASE_URL = '/stations';
const LIVE_CLUSTER_FILE = 'live-cluster.json';
const READINGS_FILE = 'readings.json';

// The single rendering switch: nodes below, individuals from here up.
const SWITCH_ZOOM = 8;
// Matches the backend's refresh cadence + the readings file's max-age.
const REFRESH_MS = 5 * 60_000;
// A reading older than this renders dimmed even if still in the file
// (backend already filters at 60 min — this is belt & braces client-side).
const STALE_MS = 60 * 60_000;

const DIM_COLOR = '#8a97a3'; // silent/stale stations & nodes without data

type WindyStation = {
	id: string;
	name: string;
	lat: number;
	lon: number;
	windKts: number | null;
	windDir: number | null;
	gustKts: number | null;
	updatedAt: number | null;
	fetchedAt: number | null;
	source: string | null;
	stale: boolean;
};

type WindyStationsConfig = {
	/** Backend origin for tap-details/search (NOT for the station files). */
	endpoint?: string;
	/** Base URL of the station files; defaults to same-origin /stations. */
	stationsBaseUrl?: string;
	visible?: boolean;
	onStationTap?: (station: WindyStation) => void;
};

// Surfr embed wind color anchors [kt, r, g, b] — identical to the GFS
// background ramp so dots read as "ground truth" samples of the same scale.
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
	[50, 173, 112, 255]
];

// MapLibre interpolate stops over a feature-state kts value.
const ktsColorStops = (): (number | string)[] => {
	const stops: (number | string)[] = [];
	for (const [k, r, g, b] of COLOR_ANCHORS) {
		stops.push(k, `rgb(${r},${g},${b})`);
	}
	return stops;
};

// Paint expression: color by live kts from feature-state, dim when absent.
// MapLibre expressions can't compare against a null literal, so absence is
// mapped to a -1 sentinel via coalesce (real kts are always >= 0).
const liveKtsColorExpr = [
	'interpolate',
	['linear'],
	['coalesce', ['feature-state', 'kts'], -1],
	-1,
	DIM_COLOR,
	...ktsColorStops()
];

const emptyFc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

// ── module state ───────────────────────────────────────────────────────────

type BaseStation = {
	lat: number;
	lon: number;
	source: string | null;
	priority: number;
};
type Reading = [number, number | null, number | null, number]; // kts, dir, gust, obsTsSec

let currentMap: maplibregl.Map | null = null;
let currentConfig: WindyStationsConfig = {};
let baseVersion: number | null = null;
let baseIndex = new Map<string, BaseStation>();
let liveIds = new Set<string>(); // ids with feature-state applied (for cleanup)
let liveNodeIds = new Set<string>();
let selectedStationId: string | number | null = null;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let pendingAbort: AbortController | undefined;
let visibilityListener: (() => void) | undefined;

const stationsBaseUrl = (): string =>
	(currentConfig.stationsBaseUrl ?? DEFAULT_STATIONS_BASE_URL).replace(/\/$/, '');

const getSource = (map: maplibregl.Map, id: string): maplibregl.GeoJSONSource | undefined =>
	map.getSource(id) as maplibregl.GeoJSONSource | undefined;

// ── image atlas (unchanged visual design) ──────────────────────────────────

// Slim white triangle, no outline — sits INSIDE a colored pill so its
// contrast comes from the pill background. Points UP at icon-rotate=0.
const ARROW_SIZE = 12;
const drawArrow = (fill: string): ImageData | null => {
	const canvas = document.createElement('canvas');
	canvas.width = ARROW_SIZE;
	canvas.height = ARROW_SIZE;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.fillStyle = fill;
	ctx.beginPath();
	// Notched chevron silhouette — reads as "arrow indicator" rather than a
	// play button.
	ctx.moveTo(ARROW_SIZE / 2, 0.5);
	ctx.lineTo(ARROW_SIZE - 0.5, ARROW_SIZE - 0.5);
	ctx.lineTo(ARROW_SIZE / 2, ARROW_SIZE * 0.62);
	ctx.lineTo(0.5, ARROW_SIZE - 0.5);
	ctx.closePath();
	ctx.fill();
	return ctx.getImageData(0, 0, ARROW_SIZE, ARROW_SIZE);
};

const ensureArrowImage = (map: maplibregl.Map): void => {
	if (!map.hasImage(ARROW_IMAGE_ID)) {
		const white = drawArrow('#ffffff');
		if (white) {
			map.addImage(ARROW_IMAGE_ID, {
				width: ARROW_SIZE,
				height: ARROW_SIZE,
				data: new Uint8Array(white.data)
			});
		}
	}
	if (!map.hasImage(ARROW_IMAGE_ID_DARK)) {
		const dark = drawArrow('#1a1a2e');
		if (dark) {
			map.addImage(ARROW_IMAGE_ID_DARK, {
				width: ARROW_SIZE,
				height: ARROW_SIZE,
				data: new Uint8Array(dark.data)
			});
		}
	}
};

const PILL_W = 36;
const PILL_H = 22;
const PILL_R = PILL_H / 2;

const drawCapsule = (fill: string): ImageData | null => {
	const canvas = document.createElement('canvas');
	canvas.width = PILL_W;
	canvas.height = PILL_H;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.fillStyle = fill;
	ctx.beginPath();
	if (typeof ctx.roundRect === 'function') {
		ctx.roundRect(0, 0, PILL_W, PILL_H, PILL_R);
	} else {
		ctx.moveTo(PILL_R, 0);
		ctx.lineTo(PILL_W - PILL_R, 0);
		ctx.arc(PILL_W - PILL_R, PILL_R, PILL_R, -Math.PI / 2, Math.PI / 2);
		ctx.lineTo(PILL_R, PILL_H);
		ctx.arc(PILL_R, PILL_R, PILL_R, Math.PI / 2, (3 * Math.PI) / 2);
		ctx.closePath();
	}
	ctx.fill();
	return ctx.getImageData(0, 0, PILL_W, PILL_H);
};

const addStretchableImage = (map: maplibregl.Map, id: string, img: ImageData): void => {
	map.addImage(
		id,
		{ width: PILL_W, height: PILL_H, data: new Uint8Array(img.data) },
		{
			content: [PILL_R, 0, PILL_W - PILL_R, PILL_H],
			stretchX: [[PILL_R, PILL_W - PILL_R]]
		}
	);
};

const ensurePillImages = (map: maplibregl.Map): void => {
	for (let i = 0; i < COLOR_ANCHORS.length; i++) {
		const id = `${PILL_IMAGE_PREFIX}${i}`;
		if (map.hasImage(id)) continue;
		const [, r, g, b] = COLOR_ANCHORS[i];
		const img = drawCapsule(`rgb(${r},${g},${b})`);
		if (img) addStretchableImage(map, id, img);
	}
};

const ensureSelectionPillImage = (map: maplibregl.Map): void => {
	if (map.hasImage(SELECTION_PILL_IMAGE_ID)) return;
	const img = drawCapsule('#22d3ee');
	if (img) addStretchableImage(map, SELECTION_PILL_IMAGE_ID, img);
};

// Verified badge — FontAwesome circle-check knocked out of the pill's right
// cap (see SRF station bottom sheet); rendered at 3× for retina crispness.
const VERIFIED_SCALE = 3;
const FA_CIRCLE_CHECK =
	'M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM369 209L241 337c-9.4 9.4-24.6 9.4-33.9 0l-64-64c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l47 47L335 175c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9z';
const drawVerified = (): ImageData | null => {
	const canvas = document.createElement('canvas');
	canvas.width = PILL_W * VERIFIED_SCALE;
	canvas.height = PILL_H * VERIFIED_SCALE;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.scale(VERIFIED_SCALE, VERIFIED_SCALE);
	const D = 10;
	const sc = D / 512;
	const cx = PILL_W - PILL_R / 2;
	const cy = PILL_H / 2;
	ctx.translate(cx - 256 * sc, cy - 256 * sc);
	ctx.scale(sc, sc);
	ctx.fillStyle = '#ffffff';
	ctx.fill(new Path2D(FA_CIRCLE_CHECK), 'evenodd');
	return ctx.getImageData(0, 0, PILL_W * VERIFIED_SCALE, PILL_H * VERIFIED_SCALE);
};

const ensureVerifiedImage = (map: maplibregl.Map): void => {
	if (map.hasImage(VERIFIED_IMAGE_ID)) return;
	const img = drawVerified();
	if (!img) return;
	const s = VERIFIED_SCALE;
	map.addImage(
		VERIFIED_IMAGE_ID,
		{ width: PILL_W * s, height: PILL_H * s, data: new Uint8Array(img.data) },
		{
			pixelRatio: s,
			content: [PILL_R * s, 0, (PILL_W - PILL_R) * s, PILL_H * s],
			stretchX: [[PILL_R * s, (PILL_W - PILL_R) * s]]
		}
	);
};

// Step expression picking the pill icon for a windKts property value.
const pillByStops = (speedExpr: unknown): unknown[] => {
	const expr: unknown[] = ['step', speedExpr, `${PILL_IMAGE_PREFIX}0`];
	for (let i = 1; i < COLOR_ANCHORS.length; i++) {
		expr.push(COLOR_ANCHORS[i][0], `${PILL_IMAGE_PREFIX}${i}`);
	}
	return expr;
};

// Yellow/orange pills (20–30 kt) have light backgrounds where white fails
// contrast — same test drives text color and arrow variant.
const isLightPillExpr = ['all', ['>=', ['get', 'windKts'], 20], ['<', ['get', 'windKts'], 30]];

// ── layers ─────────────────────────────────────────────────────────────────

const ensureLayers = (map: maplibregl.Map): void => {
	ensureArrowImage(map);
	ensurePillImages(map);
	ensureSelectionPillImage(map);
	ensureVerifiedImage(map);

	// Base source: the live-cluster file's contents (nodes + every station).
	// No MapLibre clustering — nodes are pre-baked server-side.
	if (!map.getSource(SOURCE_BASE)) {
		map.addSource(SOURCE_BASE, {
			type: 'geojson',
			data: emptyFc,
			cluster: false,
			promoteId: 'id'
		});
	}
	// Live source: only stations with a current reading — feeds the pill/
	// arrow/badge symbol layers at z8+. Rebuilt on each readings refresh.
	if (!map.getSource(SOURCE_LIVE)) {
		map.addSource(SOURCE_LIVE, {
			type: 'geojson',
			data: emptyFc,
			cluster: false,
			promoteId: 'id'
		});
	}

	// Cluster nodes — z0 up to the switch. Color = live max wind via
	// feature-state (paint-only repaint on refresh, no re-layout); radius
	// interpolates down at low zoom so world view reads as a density texture.
	if (!map.getLayer(LAYER_ID_NODES)) {
		map.addLayer({
			id: LAYER_ID_NODES,
			type: 'circle',
			source: SOURCE_BASE,
			maxzoom: SWITCH_ZOOM,
			filter: ['==', ['get', 'node'], true],
			paint: {
				'circle-color': liveKtsColorExpr as never,
				'circle-radius': [
					'interpolate',
					['linear'],
					['zoom'],
					0,
					2.5,
					4,
					5,
					SWITCH_ZOOM - 0.01,
					9
				] as never,
				'circle-stroke-width': 1,
				'circle-stroke-color': 'rgba(255,255,255,0.55)',
				'circle-opacity': 0.9
			}
		});
	}

	// Station dots — z8+, every station from the base file. Colored when a
	// live reading exists (feature-state), dimmed otherwise. Hidden (opacity
	// 0) when the station has a pill, so silent stations are exactly the
	// visible dots.
	if (!map.getLayer(LAYER_ID_DOTS)) {
		map.addLayer({
			id: LAYER_ID_DOTS,
			type: 'circle',
			source: SOURCE_BASE,
			minzoom: SWITCH_ZOOM,
			filter: ['!=', ['get', 'node'], true],
			paint: {
				'circle-color': liveKtsColorExpr as never,
				'circle-radius': 4,
				'circle-stroke-width': 1,
				'circle-stroke-color': 'rgba(255,255,255,0.4)',
				'circle-opacity': [
					'case',
					['boolean', ['feature-state', 'live'], false],
					0,
					0.55
				] as never
			}
		});
	}

	// Selection halo — solid cyan capsule rendered behind the main pill;
	// +2px icon-text-fit padding per side = a constant 2px halo at any width.
	if (!map.getLayer(LAYER_ID_SELECTION_PILL)) {
		map.addLayer({
			id: LAYER_ID_SELECTION_PILL,
			type: 'symbol',
			source: SOURCE_LIVE,
			minzoom: SWITCH_ZOOM,
			layout: {
				'icon-image': SELECTION_PILL_IMAGE_ID,
				'icon-text-fit': 'both',
				'icon-text-fit-padding': [5, 10, 5, 24],
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
				'text-field': ['to-string', ['get', 'windKtsRounded']] as never,
				'text-font': ['Noto Sans Regular'],
				'text-size': 13,
				'text-anchor': 'left',
				'text-offset': [0.5, 0.05],
				'text-allow-overlap': true,
				'text-ignore-placement': true
			},
			paint: {
				'icon-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0],
				'text-opacity': 0
			}
		});
	}

	// Capsule pill with the wind speed — individuals only (nodes are
	// color-only circles; feature-state can't drive layout, and per the
	// architecture decision clusters show no numbers/arrows).
	if (!map.getLayer(LAYER_ID_PILL)) {
		map.addLayer({
			id: LAYER_ID_PILL,
			type: 'symbol',
			source: SOURCE_LIVE,
			minzoom: SWITCH_ZOOM,
			layout: {
				'icon-image': pillByStops(['get', 'windKts']) as never,
				'icon-text-fit': 'both',
				// Extra left pad reserves space for the rotated arrow.
				'icon-text-fit-padding': [3, 8, 3, 22],
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
				'text-field': ['to-string', ['get', 'windKtsRounded']] as never,
				'text-font': ['Noto Sans Regular'],
				'text-size': 13,
				'text-anchor': 'left',
				'text-offset': [0.5, 0.05],
				'text-allow-overlap': true,
				'text-ignore-placement': true
			},
			paint: {
				'text-color': ['case', isLightPillExpr, '#1a1a2e', '#ffffff'] as never
			}
		});
	}

	// Verified badge — official sources only (not PWS).
	if (!map.getLayer(LAYER_ID_VERIFIED)) {
		map.addLayer({
			id: LAYER_ID_VERIFIED,
			type: 'symbol',
			source: SOURCE_LIVE,
			minzoom: SWITCH_ZOOM,
			filter: ['all', ['to-boolean', ['get', 'source']], ['!=', ['get', 'source'], 'pws']],
			layout: {
				'icon-image': VERIFIED_IMAGE_ID,
				'icon-text-fit': 'both',
				'icon-text-fit-padding': [3, 8, 3, 22],
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
				'text-field': ['to-string', ['get', 'windKtsRounded']] as never,
				'text-font': ['Noto Sans Regular'],
				'text-size': 13,
				'text-anchor': 'left',
				'text-offset': [0.5, 0.05],
				'text-allow-overlap': true,
				'text-ignore-placement': true
			},
			paint: { 'text-opacity': 0 }
		});
	}

	// Direction arrow — ONLY when a direction is known. A station reporting
	// speed without direction must not fabricate a due-north arrow (the old
	// `?? 0` bug). The windDir key is omitted from feature properties when the
	// reading has no direction, so `has` is the guard.
	if (!map.getLayer(LAYER_ID_ARROW)) {
		map.addLayer({
			id: LAYER_ID_ARROW,
			type: 'symbol',
			source: SOURCE_LIVE,
			minzoom: SWITCH_ZOOM,
			filter: ['has', 'windDir'],
			layout: {
				'icon-image': ['case', isLightPillExpr, ARROW_IMAGE_ID_DARK, ARROW_IMAGE_ID] as never,
				'icon-rotate': ['+', ['get', 'windDir'], 180] as never,
				'icon-rotation-alignment': 'map',
				'icon-size': 1,
				'icon-allow-overlap': true,
				'icon-ignore-placement': true
			}
		});
	}
};

// ── phase 1: the live-cluster (static base) ────────────────────────────────

type LiveClusterFeature = GeoJSON.Feature<
	GeoJSON.Point,
	{
		id: string;
		node?: boolean;
		count?: number;
		expansionZoom?: number;
		source?: string;
		priority?: number;
		offline?: boolean;
	}
>;

const loadBase = async (map: maplibregl.Map, reload = false): Promise<boolean> => {
	try {
		const res = await fetch(`${stationsBaseUrl()}/${LIVE_CLUSTER_FILE}`, {
			cache: reload ? 'reload' : 'default'
		});
		if (!res.ok) return false;
		const fc = (await res.json()) as GeoJSON.FeatureCollection & { v?: number };
		if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return false;

		baseVersion = typeof fc.v === 'number' ? fc.v : null;
		baseIndex = new Map();
		for (const f of fc.features as LiveClusterFeature[]) {
			const p = f.properties;
			if (!p || p.node || !f.geometry) continue;
			baseIndex.set(p.id, {
				lon: f.geometry.coordinates[0],
				lat: f.geometry.coordinates[1],
				source: p.source ?? null,
				priority: p.priority ?? 1
			});
		}
		getSource(map, SOURCE_BASE)?.setData(fc);
		return true;
	} catch (e) {
		console.warn('[windy-stations] live-cluster load failed', e);
		return false;
	}
};

// ── phase 2: readings hydration ────────────────────────────────────────────

type ReadingsFile = {
	v?: number;
	ts?: number;
	stations?: Record<string, Reading>;
	nodes?: Record<string, number>;
};

const applyReadings = (map: maplibregl.Map, readings: ReadingsFile): void => {
	const nowSec = Date.now() / 1000;
	const stations = readings.stations ?? {};
	const nodes = readings.nodes ?? {};

	// Node colors — pure feature-state repaint.
	const nextNodeIds = new Set<string>();
	for (const [cellId, maxKts] of Object.entries(nodes)) {
		map.setFeatureState({ source: SOURCE_BASE, id: cellId }, { kts: maxKts });
		nextNodeIds.add(cellId);
	}
	for (const cellId of liveNodeIds) {
		if (!nextNodeIds.has(cellId)) {
			map.removeFeatureState({ source: SOURCE_BASE, id: cellId }, 'kts');
		}
	}
	liveNodeIds = nextNodeIds;

	// Station dots + the live (pill) source.
	const nextLiveIds = new Set<string>();
	const features: GeoJSON.Feature[] = [];
	for (const [id, r] of Object.entries(stations)) {
		const base = baseIndex.get(id);
		if (!base) continue; // unknown id — station newer than our live-cluster
		const [kts, dir, gust, obsTsSec] = r;
		if (kts == null || nowSec - obsTsSec > STALE_MS / 1000) continue;

		map.setFeatureState({ source: SOURCE_BASE, id }, { kts, live: true });
		nextLiveIds.add(id);

		// Null-valued keys are OMITTED (not set to null): the arrow layer's
		// `has windDir` filter relies on absence, and MapLibre expressions
		// can't test against null literals.
		const props: Record<string, unknown> = {
			id,
			windKts: kts,
			windKtsRounded: Math.round(kts),
			updatedAt: obsTsSec * 1000
		};
		if (dir != null) props.windDir = dir;
		if (gust != null) props.gustKts = gust;
		if (base.source != null) props.source = base.source;
		features.push({
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [base.lon, base.lat] },
			properties: props as GeoJSON.GeoJsonProperties
		});
	}
	for (const id of liveIds) {
		if (!nextLiveIds.has(id)) {
			map.removeFeatureState({ source: SOURCE_BASE, id });
		}
	}
	liveIds = nextLiveIds;

	getSource(map, SOURCE_LIVE)?.setData({ type: 'FeatureCollection', features });
};

const refreshReadings = async (map: maplibregl.Map): Promise<void> => {
	pendingAbort?.abort();
	pendingAbort = new AbortController();
	try {
		const res = await fetch(`${stationsBaseUrl()}/${READINGS_FILE}`, {
			signal: pendingAbort.signal
		});
		if (!res.ok) return;
		const readings = (await res.json()) as ReadingsFile;

		// Version guard: the nightly rotation changed the live-cluster while we
		// hold a cached copy — refetch it (usually a cheap 304/cache-hit), then
		// apply the readings against the fresh base.
		if (
			typeof readings.v === 'number' &&
			baseVersion !== null &&
			readings.v !== baseVersion
		) {
			await loadBase(map, true);
		}
		applyReadings(map, readings);
	} catch (e) {
		if ((e as Error).name === 'AbortError') return;
		console.warn('[windy-stations] readings refresh failed', e);
	}
};

// ── refresh loop (paused when hidden or layer off) ─────────────────────────

const stopTimer = (): void => {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = undefined;
	}
};

const startTimer = (map: maplibregl.Map): void => {
	stopTimer();
	refreshTimer = setInterval(() => {
		if (document.visibilityState === 'visible' && currentConfig.visible) {
			void refreshReadings(map);
		}
	}, REFRESH_MS);
};

const onVisibilityChange = (): void => {
	if (!currentMap) return;
	if (document.visibilityState === 'visible' && currentConfig.visible) {
		// Catch up immediately after returning to the foreground.
		void refreshReadings(currentMap);
		startTimer(currentMap);
	} else {
		stopTimer();
	}
};

// ── interactions ───────────────────────────────────────────────────────────

const handleStationClick = (
	e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }
): void => {
	if (!currentMap) return;
	const f = e.features?.[0];
	if (!f) return;
	const id = (f.properties?.id ?? f.id) as string | undefined;
	if (id == null) return;

	if (selectedStationId != null && selectedStationId !== id) {
		try {
			currentMap.removeFeatureState({ source: SOURCE_LIVE, id: selectedStationId }, 'selected');
		} catch {
			/* state may not exist after data refresh — ignore */
		}
	}
	currentMap.setFeatureState({ source: SOURCE_LIVE, id }, { selected: true });
	selectedStationId = id;

	const base = baseIndex.get(id);
	const props = f.properties ?? {};
	const station: WindyStation = {
		id,
		name: '', // live-cluster carries no names — fetched below
		lat: base?.lat ?? Number(props.lat) ?? 0,
		lon: base?.lon ?? Number(props.lon) ?? 0,
		windKts: (props.windKts as number | null) ?? null,
		windDir: (props.windDir as number | null) ?? null,
		gustKts: (props.gustKts as number | null) ?? null,
		updatedAt: (props.updatedAt as number | null) ?? null,
		fetchedAt: null,
		source: base?.source ?? (props.source as string | null) ?? null,
		stale: false
	};

	// Names live on the backend, not in the station files. One tiny lookup per
	// tap keeps the file payloads lean; fire the callback immediately so the
	// sheet opens without waiting, then enrich when the name arrives.
	currentConfig.onStationTap?.(station);
	const endpoint = currentConfig.endpoint?.replace(/\/$/, '');
	if (endpoint) {
		fetch(`${endpoint}/windystations/search?q=${encodeURIComponent(id)}&limit=1`)
			.then((r) => (r.ok ? r.json() : null))
			.then((results: { id: string; name?: string }[] | null) => {
				const match = Array.isArray(results) ? results.find((s) => s.id === id) : null;
				if (match?.name) {
					currentConfig.onStationTap?.({ ...station, name: match.name });
				}
			})
			.catch(() => {
				/* name enrichment is best-effort */
			});
	}
};

// Node drill-down — the expansion zoom is baked server-side; no async
// getClusterExpansionZoom round-trip.
const handleNodeClick = (
	e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }
): void => {
	if (!currentMap) return;
	const f = e.features?.[0];
	if (!f || f.geometry.type !== 'Point') return;
	const zoom = Number(f.properties?.expansionZoom ?? SWITCH_ZOOM);
	currentMap.easeTo({
		center: f.geometry.coordinates as [number, number],
		zoom,
		duration: 500
	});
};

const setCursorPointer = (): void => {
	if (currentMap) currentMap.getCanvas().style.cursor = 'pointer';
};
const setCursorDefault = (): void => {
	if (currentMap) currentMap.getCanvas().style.cursor = '';
};

const INTERACTIVE_STATION_LAYERS = [LAYER_ID_PILL, LAYER_ID_ARROW, LAYER_ID_DOTS];

const attachInteractionHandlers = (map: maplibregl.Map): void => {
	for (const layerId of INTERACTIVE_STATION_LAYERS) {
		map.on('click', layerId, handleStationClick);
		map.on('mouseenter', layerId, setCursorPointer);
		map.on('mouseleave', layerId, setCursorDefault);
	}
	map.on('click', LAYER_ID_NODES, handleNodeClick);
	map.on('mouseenter', LAYER_ID_NODES, setCursorPointer);
	map.on('mouseleave', LAYER_ID_NODES, setCursorDefault);
};

const detachInteractionHandlers = (map: maplibregl.Map): void => {
	for (const layerId of INTERACTIVE_STATION_LAYERS) {
		map.off('click', layerId, handleStationClick);
		map.off('mouseenter', layerId, setCursorPointer);
		map.off('mouseleave', layerId, setCursorDefault);
	}
	map.off('click', LAYER_ID_NODES, handleNodeClick);
	map.off('mouseenter', LAYER_ID_NODES, setCursorPointer);
	map.off('mouseleave', LAYER_ID_NODES, setCursorDefault);
};

// ── public API (unchanged surface) ─────────────────────────────────────────

const ALL_LAYERS = [
	LAYER_ID_NODES,
	LAYER_ID_DOTS,
	LAYER_ID_SELECTION_PILL,
	LAYER_ID_PILL,
	LAYER_ID_VERIFIED,
	LAYER_ID_ARROW
];

const bootstrap = async (map: maplibregl.Map): Promise<void> => {
	const ok = await loadBase(map);
	if (ok) await refreshReadings(map);
};

export const initWindyStations = (map: maplibregl.Map): void => {
	// Boundary guard: a stations-layer failure must never break the caller's
	// map-load flow (the RN bridge installs after us) — degrade to "no station
	// layer" and shout in the console instead.
	try {
		currentMap = map;
		ensureLayers(map);
		attachInteractionHandlers(map);
		visibilityListener = onVisibilityChange;
		document.addEventListener('visibilitychange', visibilityListener);
	} catch (e) {
		console.error('[windy-stations] init failed — station layer disabled', e);
	}
};

export const setWindyStationsConfig = (config: WindyStationsConfig): void => {
	currentConfig = { ...currentConfig, ...config };
	if (currentMap && currentConfig.visible) {
		void bootstrap(currentMap);
		startTimer(currentMap);
	}
};

export const setWindyStationsVisible = (map: maplibregl.Map, visible: boolean): void => {
	currentConfig.visible = visible;
	const vis = visible ? 'visible' : 'none';
	for (const layerId of ALL_LAYERS) {
		if (map.getLayer(layerId)) {
			map.setLayoutProperty(layerId, 'visibility', vis);
		}
	}
	if (visible && currentMap) {
		if (baseVersion === null) {
			// First show (RN configures endpoint and visibility in separate
			// messages, so the config path may never have bootstrapped): load
			// the live-cluster before hydrating, or readings have nothing to
			// attach to.
			void bootstrap(currentMap);
		} else {
			// Re-show: cached data is still on the sources; just catch up.
			void refreshReadings(currentMap);
		}
		startTimer(currentMap);
	} else {
		stopTimer();
	}
};

export const teardownWindyStations = (map: maplibregl.Map): void => {
	detachInteractionHandlers(map);
	stopTimer();
	if (visibilityListener) {
		document.removeEventListener('visibilitychange', visibilityListener);
		visibilityListener = undefined;
	}
	pendingAbort?.abort();
	pendingAbort = undefined;
	getSource(map, SOURCE_BASE)?.setData(emptyFc);
	getSource(map, SOURCE_LIVE)?.setData(emptyFc);
	selectedStationId = null;
	baseIndex.clear();
	liveIds.clear();
	liveNodeIds.clear();
	baseVersion = null;
	currentMap = null;
};
