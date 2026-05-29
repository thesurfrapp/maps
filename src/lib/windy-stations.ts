// Render live wind station data from the Surfr backend on the map.
//
// Uses a clustered GeoJSON source + circle/symbol layers (mirrors the pattern
// already established in surfr-spots.ts). At low zoom, stations aggregate into
// count bubbles colored by average wind speed. At medium+ zoom, individual
// stations render as colored dots with a small white arrow indicating wind
// direction (pointing downwind, away from the station). Speed numbers appear
// at zoom 11+. Verified stations — those from an official source (KNMI/METAR/
// NDBC, i.e. anything other than a Windy PWS) — carry a small white checkmark
// badge (navy tick) on the right of the pill.
//
// Replaces the previous DOM-marker-per-station approach which could not
// cluster and became unreadable in dense regions (NL/DE/BE) at country zoom.
//
// API surface preserved: initWindyStations, setWindyStationsConfig,
// setWindyStationsVisible, teardownWindyStations. rn-bridge.ts and
// overlay-pills.svelte do not need to change.
import type * as maplibregl from 'maplibre-gl';

const SOURCE_ID = 'windy-stations';
export const LAYER_ID_SELECTION_PILL = 'windy-stations-selection-pill';
export const LAYER_ID_PILL = 'windy-stations-pill';
export const LAYER_ID_ARROW = 'windy-stations-arrow';
export const LAYER_ID_VERIFIED = 'windy-stations-verified';
const ARROW_IMAGE_ID = 'windy-station-arrow';
const ARROW_IMAGE_ID_DARK = 'windy-station-arrow-dark';
const PILL_IMAGE_PREFIX = 'windy-station-pill-';
const SELECTION_PILL_IMAGE_ID = 'windy-station-selection-pill';
const VERIFIED_IMAGE_ID = 'windy-station-verified';

const MIN_ZOOM = 5;
// Bumped from 200 — clustering aggregates client-side, so the backend needs to
// send enough raw points for cluster counts to be representative at country
// zoom. Backend already dedups within 2km, so the realistic visible-bbox cap
// for individual stations is well below this.
const LIMIT = 500;
const DEBOUNCE_MS = 700;
// V2: dropped 9 → 7 so individual stations appear sooner (Windy-style scan
// at regional zoom). At country zoom (5-6) we still cluster to avoid pile-up.
const CLUSTER_MAX_ZOOM = 7;
const CLUSTER_RADIUS = 50;
const RAD_TO_DEG = 57.29577951308232;

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
	endpoint?: string;
	visible?: boolean;
	onStationTap?: (station: WindyStation) => void;
};

// Surfr embed wind color anchors [kt, r, g, b] — kept identical to the GFS
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

// MapLibre interpolate stops: [k0, rgb0, k1, rgb1, ...]
const buildColorStops = (): (number | string)[] => {
	const stops: (number | string)[] = [];
	for (const [k, r, g, b] of COLOR_ANCHORS) {
		stops.push(k, `rgb(${r},${g},${b})`);
	}
	return stops;
};

const emptyFc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

let currentMap: maplibregl.Map | null = null;
let currentConfig: WindyStationsConfig = {};
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let pendingAbort: AbortController | undefined;
let selectedStationId: string | number | null = null;
// Cache of the latest fetched stations by id so the click handler can pass the
// full WindyStation object (including stale + fetchedAt) to onStationTap.
// Feature properties carry the subset rn-bridge actually forwards to RN.
let stationById = new Map<string | number, WindyStation>();

const getSource = (map: maplibregl.Map): maplibregl.GeoJSONSource | undefined =>
	map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;

// Slim white triangle, no outline — sits INSIDE a colored pill in V4 so its
// contrast comes from the pill background, not from a halo. Points UP at
// icon-rotate=0; the arrow layer applies the per-feature bearing so it ends
// up pointing where the wind is blowing TOWARD.
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
	// play button. Apex at top, sharp diagonals down to the lower corners,
	// inner notch lifts the base in the middle.
	ctx.moveTo(ARROW_SIZE / 2, 0.5);
	ctx.lineTo(ARROW_SIZE - 0.5, ARROW_SIZE - 0.5);
	ctx.lineTo(ARROW_SIZE / 2, ARROW_SIZE * 0.62);
	ctx.lineTo(0.5, ARROW_SIZE - 0.5);
	ctx.closePath();
	ctx.fill();
	return ctx.getImageData(0, 0, ARROW_SIZE, ARROW_SIZE);
};

// Register both arrow variants. White is used on dark/blue/green pills;
// dark navy is used on yellow/orange pills (20-30 kt) where white text +
// arrow would fail contrast. icon-image case expression picks the right
// variant per feature.
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

// Pre-rendered colored capsule (rounded pill) images — one per wind-speed
// band from COLOR_ANCHORS. The pill stretches horizontally via stretchX so
// `icon-text-fit: 'both'` can grow it to wrap longer numbers (e.g. "8" vs
// "17"). The round caps stay at fixed size; only the 14px middle stretches.
// content defines where MapLibre places the text inside the pill so the
// round caps stay clear.
const PILL_W = 36;
const PILL_H = 22;
const PILL_R = PILL_H / 2; // capsule (fully rounded ends)
const ensurePillImages = (map: maplibregl.Map): void => {
	for (let i = 0; i < COLOR_ANCHORS.length; i++) {
		const id = `${PILL_IMAGE_PREFIX}${i}`;
		if (map.hasImage(id)) continue;
		const [, r, g, b] = COLOR_ANCHORS[i];
		const canvas = document.createElement('canvas');
		canvas.width = PILL_W;
		canvas.height = PILL_H;
		const ctx = canvas.getContext('2d');
		if (!ctx) continue;
		ctx.fillStyle = `rgb(${r},${g},${b})`;
		ctx.beginPath();
		// Capsule
		if (typeof ctx.roundRect === 'function') {
			ctx.roundRect(0, 0, PILL_W, PILL_H, PILL_R);
		} else {
			// Fallback for environments without roundRect — manual arcs
			ctx.moveTo(PILL_R, 0);
			ctx.lineTo(PILL_W - PILL_R, 0);
			ctx.arc(PILL_W - PILL_R, PILL_R, PILL_R, -Math.PI / 2, Math.PI / 2);
			ctx.lineTo(PILL_R, PILL_H);
			ctx.arc(PILL_R, PILL_R, PILL_R, Math.PI / 2, (3 * Math.PI) / 2);
			ctx.closePath();
		}
		ctx.fill();
		const imageData = ctx.getImageData(0, 0, PILL_W, PILL_H);
		map.addImage(
			id,
			{
				width: PILL_W,
				height: PILL_H,
				data: new Uint8Array(imageData.data)
			},
			{
				content: [PILL_R, 0, PILL_W - PILL_R, PILL_H],
				stretchX: [[PILL_R, PILL_W - PILL_R]]
			}
		);
	}
};

// Selection halo — a SOLID cyan capsule at the same base dimensions as the
// main pill, rendered behind the main pill via layer order. The layer config
// uses 2px-larger icon-text-fit-padding on each side, so the cyan capsule
// renders 4px bigger than the main pill at any text size — the visible cyan
// around the main pill's edges IS the halo. Solid fill avoids the stroke
// stretching artifacts the previous outline approach had, and the halo width
// stays a consistent 2px whether the pill contains "6" or "16" or "116".
const ensureSelectionPillImage = (map: maplibregl.Map): void => {
	if (map.hasImage(SELECTION_PILL_IMAGE_ID)) return;
	const canvas = document.createElement('canvas');
	canvas.width = PILL_W;
	canvas.height = PILL_H;
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	ctx.fillStyle = '#22d3ee';
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
	const imageData = ctx.getImageData(0, 0, PILL_W, PILL_H);
	map.addImage(
		SELECTION_PILL_IMAGE_ID,
		{
			width: PILL_W,
			height: PILL_H,
			data: new Uint8Array(imageData.data)
		},
		{
			content: [PILL_R, 0, PILL_W - PILL_R, PILL_H],
			stretchX: [[PILL_R, PILL_W - PILL_R]]
		}
	);
};

// Verified badge — FontAwesome `circle-check` (solid), the same glyph the
// station bottom sheet shows, so the pill badge and the sheet's verified mark
// read as one thing. Filled white with the tick as an even-odd knockout, so the
// pill color shows through the tick and the badge stays legible on every pill
// color — the same way the white number/arrow already do. Baked into the
// transparent capsule's fixed RIGHT cap (shared content / stretchX with the
// pill); its own symbol layer icon-text-fits to the same number, keeping it
// pinned to the pill's right edge at any text width, like the selection halo.
// Rendered at SCALE× with a matching pixelRatio so the glyph stays crisp on
// retina / when icon-text-fit scales it (a 1× raster aliases at this size).
const VERIFIED_SCALE = 3;
// circle-check (FA6 solid, viewBox 0 0 512 512): outer disc + tick subpath —
// even-odd fill turns the tick into a transparent knockout.
const FA_CIRCLE_CHECK =
	'M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM369 209L241 337c-9.4 9.4-24.6 9.4-33.9 0l-64-64c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l47 47L335 175c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9z';
const drawVerified = (): ImageData | null => {
	const canvas = document.createElement('canvas');
	canvas.width = PILL_W * VERIFIED_SCALE;
	canvas.height = PILL_H * VERIFIED_SCALE;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.scale(VERIFIED_SCALE, VERIFIED_SCALE);
	const D = 10; // badge diameter (logical px)
	const sc = D / 512;
	// Center inside the pill's rounded right cap so the disc sits ENTIRELY in the
	// fixed cap region — never straddling the stretch zone (which shears it) and
	// inscribed within the capsule's rounded end (so it can't poke past the
	// rounded edge and read as clipped).
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

// Step expression that picks the pill icon based on a speed value (kt).
// Used for both individuals (windKts) and clusters (sumKts/point_count).
const pillByStops = (speedExpr: unknown): unknown[] => [
	'step',
	speedExpr,
	`${PILL_IMAGE_PREFIX}0`,
	COLOR_ANCHORS[1][0],
	`${PILL_IMAGE_PREFIX}1`,
	COLOR_ANCHORS[2][0],
	`${PILL_IMAGE_PREFIX}2`,
	COLOR_ANCHORS[3][0],
	`${PILL_IMAGE_PREFIX}3`,
	COLOR_ANCHORS[4][0],
	`${PILL_IMAGE_PREFIX}4`,
	COLOR_ANCHORS[5][0],
	`${PILL_IMAGE_PREFIX}5`,
	COLOR_ANCHORS[6][0],
	`${PILL_IMAGE_PREFIX}6`,
	COLOR_ANCHORS[7][0],
	`${PILL_IMAGE_PREFIX}7`,
	COLOR_ANCHORS[8][0],
	`${PILL_IMAGE_PREFIX}8`,
	COLOR_ANCHORS[9][0],
	`${PILL_IMAGE_PREFIX}9`
];

// atan2(sumE, sumN) reconstruction in MapLibre style expressions (no native
// atan2 — only atan). Returns the compass bearing in degrees that the wind
// is blowing TOWARD, averaged across the cluster.
const clusterBearingExpr = [
	'let',
	'n',
	['get', 'sumN'],
	'e',
	['get', 'sumE'],
	[
		'case',
		['>', ['var', 'n'], 0],
		['*', ['atan', ['/', ['var', 'e'], ['var', 'n']]], RAD_TO_DEG],
		['<', ['var', 'n'], 0],
		[
			'case',
			['>=', ['var', 'e'], 0],
			['+', ['*', ['atan', ['/', ['var', 'e'], ['var', 'n']]], RAD_TO_DEG], 180],
			['-', ['*', ['atan', ['/', ['var', 'e'], ['var', 'n']]], RAD_TO_DEG], 180]
		],
		['case', ['>', ['var', 'e'], 0], 90, ['<', ['var', 'e'], 0], -90, 0]
	]
];

const ensureLayers = (map: maplibregl.Map): void => {
	ensureArrowImage(map);
	ensurePillImages(map);
	ensureSelectionPillImage(map);
	ensureVerifiedImage(map);

	if (!map.getSource(SOURCE_ID)) {
		map.addSource(SOURCE_ID, {
			type: 'geojson',
			data: emptyFc,
			cluster: true,
			clusterRadius: CLUSTER_RADIUS,
			clusterMaxZoom: CLUSTER_MAX_ZOOM,
			promoteId: 'id',
			clusterProperties: {
				// Sum of windKts across cluster — divide by point_count when
				// painting/labeling to get the average speed.
				sumKts: ['+', ['get', 'windKts']],
				// Component sums for vector-averaging direction across the
				// cluster (reconstructed via atan2 case-expression below).
				sumE: ['+', ['get', 'dirE']],
				sumN: ['+', ['get', 'dirN']]
			}
		});
	}

	// Selection halo — solid cyan capsule, rendered behind the main pill via
	// layer order. icon-opacity gates visibility through feature-state so it
	// only shows around the tapped station. icon-text-fit-padding is 2px
	// larger on every side than the main pill's, so the halo capsule renders
	// 4px bigger than the main pill at any text width — the visible cyan
	// around the main pill's edges IS the halo.
	if (!map.getLayer(LAYER_ID_SELECTION_PILL)) {
		map.addLayer({
			id: LAYER_ID_SELECTION_PILL,
			type: 'symbol',
			source: SOURCE_ID,
			minzoom: MIN_ZOOM,
			filter: ['!', ['has', 'point_count']],
			layout: {
				'icon-image': SELECTION_PILL_IMAGE_ID,
				'icon-text-fit': 'both',
				// Padding is +2px on each side relative to the main pill's
				// [3, 8, 3, 22] — keeps halo a constant 2px regardless of
				// whether the pill contains "6" or "16" or "116".
				'icon-text-fit-padding': [5, 10, 5, 24],
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
				// Reuse the same text content so icon-text-fit has something
				// to size against; text itself is invisible (opacity 0 below).
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

	// Capsule pill with the wind speed (kt) — one unified layer for clusters
	// and individuals. icon-text-fit grows the pre-rendered pill image around
	// the speed text so 1-digit and 2-digit numbers both look balanced. The
	// extra left padding reserves space for the rotated arrow drawn by the
	// arrow layer at the geometry point.
	if (!map.getLayer(LAYER_ID_PILL)) {
		map.addLayer({
			id: LAYER_ID_PILL,
			type: 'symbol',
			source: SOURCE_ID,
			minzoom: MIN_ZOOM,
			layout: {
				'icon-image': [
					'case',
					['has', 'point_count'],
					pillByStops(['/', ['get', 'sumKts'], ['get', 'point_count']]),
					pillByStops(['get', 'windKts'])
				] as never,
				'icon-text-fit': 'both',
				// [top, right, bottom, left] — extra left pad makes room for
				// the arrow drawn separately at the geometry point. V5 bumps
				// left from 18 → 22 to keep the arrow visually breathing room
				// from the number, especially when the arrow is rotated wide.
				'icon-text-fit-padding': [3, 8, 3, 22],
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
				'text-field': [
					'case',
					['has', 'point_count'],
					['to-string', ['round', ['/', ['get', 'sumKts'], ['get', 'point_count']]]],
					['to-string', ['get', 'windKtsRounded']]
				] as never,
				'text-font': ['Noto Sans Regular'],
				'text-size': 13,
				'text-anchor': 'left',
				'text-offset': [0.5, 0.05],
				'text-allow-overlap': true,
				'text-ignore-placement': true
			},
			paint: {
				// Yellow/orange pills (20-30 kt) have light backgrounds and
				// white text fails contrast on them. Mirror V1's textColor()
				// logic with a data-driven expression. For clusters, use the
				// cluster's average speed; for individuals, use windKts.
				'text-color': [
					'case',
					['has', 'point_count'],
					[
						'case',
						[
							'all',
							['>=', ['/', ['get', 'sumKts'], ['get', 'point_count']], 20],
							['<', ['/', ['get', 'sumKts'], ['get', 'point_count']], 30]
						],
						'#1a1a2e',
						'#ffffff'
					],
					[
						'case',
						['all', ['>=', ['get', 'windKts'], 20], ['<', ['get', 'windKts'], 30]],
						'#1a1a2e',
						'#ffffff'
					]
				] as never
			}
		});
	}

	// Verified badge — green check on the pill's right cap for stations from an
	// official source (not a Windy PWS). Separate layer that icon-text-fits to
	// the same number as the pill, so its right cap aligns with the pill's at
	// any width. Individuals only — clusters mix sources, so no badge. The text
	// is invisible (opacity 0) and exists only to drive icon-text-fit sizing.
	if (!map.getLayer(LAYER_ID_VERIFIED)) {
		map.addLayer({
			id: LAYER_ID_VERIFIED,
			type: 'symbol',
			source: SOURCE_ID,
			minzoom: MIN_ZOOM,
			filter: [
				'all',
				['!', ['has', 'point_count']],
				['to-boolean', ['get', 'source']],
				['!=', ['get', 'source'], 'pws']
			],
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
			paint: {
				'text-opacity': 0
			}
		});
	}

	// Triangle arrow rendered AT the geometry point (icon-offset [0,0]) so it
	// stays planted in the pill's left padding when icon-rotate spins it. For
	// clusters we use the atan2(sumE, sumN) reconstruction; for individuals
	// we use windDir + 180 directly. icon-image picks the white or dark-navy
	// arrow variant on the same speed test that text-color uses, so the
	// arrow always matches the text color on yellow/orange pills.
	if (!map.getLayer(LAYER_ID_ARROW)) {
		map.addLayer({
			id: LAYER_ID_ARROW,
			type: 'symbol',
			source: SOURCE_ID,
			minzoom: MIN_ZOOM,
			layout: {
				'icon-image': [
					'case',
					['has', 'point_count'],
					[
						'case',
						[
							'all',
							['>=', ['/', ['get', 'sumKts'], ['get', 'point_count']], 20],
							['<', ['/', ['get', 'sumKts'], ['get', 'point_count']], 30]
						],
						ARROW_IMAGE_ID_DARK,
						ARROW_IMAGE_ID
					],
					[
						'case',
						['all', ['>=', ['get', 'windKts'], 20], ['<', ['get', 'windKts'], 30]],
						ARROW_IMAGE_ID_DARK,
						ARROW_IMAGE_ID
					]
				] as never,
				'icon-rotate': [
					'case',
					['has', 'point_count'],
					clusterBearingExpr,
					['+', ['get', 'windDir'], 180]
				] as never,
				'icon-rotation-alignment': 'map',
				'icon-size': 1,
				'icon-allow-overlap': true,
				'icon-ignore-placement': true
			}
		});
	}
};

const toFeatureCollection = (stations: WindyStation[]): GeoJSON.FeatureCollection => {
	stationById = new Map();
	return {
		type: 'FeatureCollection',
		features: stations
			// V1: hide stale (>1h old) and no-wind-reading stations. Both add
			// visual noise without giving the user a usable signal. Can be
			// gated behind a future "show all" filter if needed.
			.filter((s) => !s.stale && s.windKts != null)
			.map((s): GeoJSON.Feature | null => {
				const lat = typeof s.lat === 'string' ? parseFloat(s.lat) : s.lat;
				const lon = typeof s.lon === 'string' ? parseFloat(s.lon) : s.lon;
				if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
				stationById.set(s.id, s);
				// Precompute unit-vector components of the "blowing-to" direction
				// so MapLibre can vector-average them across a cluster via the
				// clusterProperties sum aggregator, then recover the average
				// bearing with the atan2 case-expression in the cluster-arrow
				// layer. Unit vectors (unweighted by speed) keep cluster direction
				// purely directional; speed influences only color.
				const bearingRad = (((s.windDir ?? 0) + 180) * Math.PI) / 180;
				return {
					type: 'Feature',
					geometry: { type: 'Point', coordinates: [lon, lat] },
					properties: {
						id: s.id,
						name: s.name,
						lat,
						lon,
						windKts: s.windKts,
						windKtsRounded: s.windKts != null ? Math.round(s.windKts) : null,
						windDir: s.windDir,
						gustKts: s.gustKts,
						updatedAt: s.updatedAt,
						source: s.source,
						dirE: Math.sin(bearingRad),
						dirN: Math.cos(bearingRad)
					}
				};
			})
			.filter((f): f is GeoJSON.Feature => f !== null)
	};
};

const reconstructStationFromProps = (props: Record<string, unknown>): WindyStation => ({
	id: String(props.id),
	name: String(props.name ?? ''),
	lat: Number(props.lat),
	lon: Number(props.lon),
	windKts: (props.windKts as number | null) ?? null,
	windDir: (props.windDir as number | null) ?? null,
	gustKts: (props.gustKts as number | null) ?? null,
	updatedAt: (props.updatedAt as number | null) ?? null,
	fetchedAt: null,
	source: (props.source as string | null) ?? null,
	stale: false
});

const handleStationClick = (
	e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }
): void => {
	if (!currentMap) return;
	const f = e.features?.[0];
	if (!f) return;
	const id = (f.properties?.id ?? f.id) as string | number | undefined;
	if (id == null) return;

	// Swap selection feature-state. promoteId on the source keeps these
	// keyed by the backend station id, so state persists across re-fetches
	// of the same station.
	if (selectedStationId != null && selectedStationId !== id) {
		try {
			currentMap.removeFeatureState({ source: SOURCE_ID, id: selectedStationId }, 'selected');
		} catch {
			/* state may not exist after data refresh — ignore */
		}
	}
	currentMap.setFeatureState({ source: SOURCE_ID, id }, { selected: true });
	selectedStationId = id;

	const cached = stationById.get(id);
	currentConfig.onStationTap?.(cached ?? reconstructStationFromProps(f.properties ?? {}));
};

const handleClusterClick = (
	e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }
): void => {
	if (!currentMap) return;
	const f = e.features?.[0];
	if (!f) return;
	const clusterId = f.properties?.cluster_id;
	if (clusterId == null) return;
	const src = getSource(currentMap);
	src
		?.getClusterExpansionZoom(clusterId)
		.then((zoom: number) => {
			if (f.geometry.type !== 'Point') return;
			currentMap?.easeTo({
				center: f.geometry.coordinates as [number, number],
				zoom,
				duration: 500
			});
		})
		.catch(() => {
			/* harmless if cluster has been re-rendered between click and expansion */
		});
};

const setCursorPointer = (): void => {
	if (currentMap) currentMap.getCanvas().style.cursor = 'pointer';
};
const setCursorDefault = (): void => {
	if (currentMap) currentMap.getCanvas().style.cursor = '';
};

const fetchAndRender = async (map: maplibregl.Map, config: WindyStationsConfig): Promise<void> => {
	if (!config.endpoint || !config.visible) return;
	if (map.getZoom() < MIN_ZOOM) {
		getSource(map)?.setData(emptyFc);
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
		ensureLayers(map);
		getSource(map)?.setData(toFeatureCollection(stations));
	} catch (e) {
		if ((e as Error).name === 'AbortError') return;
		console.warn('[windy-stations] fetch failed', e);
	}
};

const debounced = (map: maplibregl.Map): void => {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => fetchAndRender(map, currentConfig), DEBOUNCE_MS);
};

const onMoveEnd = (): void => {
	if (currentMap && currentConfig.visible) debounced(currentMap);
};

// V4 collapses clusters + individuals into one pill layer, so the click
// handler dispatches based on whether the tapped feature has point_count.
// Arrow layer also gets the handlers since arrow taps land there (it sits
// on top of the pill in the layer stack).
const handlePillOrArrowClick = (
	e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }
): void => {
	const f = e.features?.[0];
	if (!f) return;
	if (f.properties && 'point_count' in f.properties) {
		handleClusterClick(e);
	} else {
		handleStationClick(e);
	}
};

const INTERACTIVE_LAYERS = [LAYER_ID_PILL, LAYER_ID_ARROW];

const attachInteractionHandlers = (map: maplibregl.Map): void => {
	for (const layerId of INTERACTIVE_LAYERS) {
		map.on('click', layerId, handlePillOrArrowClick);
		map.on('mouseenter', layerId, setCursorPointer);
		map.on('mouseleave', layerId, setCursorDefault);
	}
};

const detachInteractionHandlers = (map: maplibregl.Map): void => {
	for (const layerId of INTERACTIVE_LAYERS) {
		map.off('click', layerId, handlePillOrArrowClick);
		map.off('mouseenter', layerId, setCursorPointer);
		map.off('mouseleave', layerId, setCursorDefault);
	}
};

export const initWindyStations = (map: maplibregl.Map): void => {
	currentMap = map;
	ensureLayers(map);
	attachInteractionHandlers(map);
	map.on('moveend', onMoveEnd);
};

export const setWindyStationsConfig = (config: WindyStationsConfig): void => {
	currentConfig = { ...currentConfig, ...config };
	if (currentMap && currentConfig.visible) fetchAndRender(currentMap, currentConfig);
};

export const setWindyStationsVisible = (map: maplibregl.Map, visible: boolean): void => {
	currentConfig.visible = visible;
	// Toggle layer visibility for an instant hide/show; cached source data
	// stays put so re-show doesn't refetch.
	const vis = visible ? 'visible' : 'none';
	for (const layerId of [
		LAYER_ID_SELECTION_PILL,
		LAYER_ID_PILL,
		LAYER_ID_VERIFIED,
		LAYER_ID_ARROW
	]) {
		if (map.getLayer(layerId)) {
			map.setLayoutProperty(layerId, 'visibility', vis);
		}
	}
	if (visible && currentMap) {
		fetchAndRender(currentMap, currentConfig);
	}
};

export const teardownWindyStations = (map: maplibregl.Map): void => {
	map.off('moveend', onMoveEnd);
	detachInteractionHandlers(map);
	pendingAbort?.abort();
	pendingAbort = undefined;
	if (debounceTimer) {
		clearTimeout(debounceTimer);
		debounceTimer = undefined;
	}
	getSource(map)?.setData(emptyFc);
	selectedStationId = null;
	stationById.clear();
	currentMap = null;
};
