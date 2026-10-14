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
// Cluster nodes do the same from a third small source: the nodes plus their
// live max wind, because the stacked-badge image is picked by wind band and
// feature-state can't drive icon-image.
//
// One rendering switch at z8 (same shape as spots, without spots' data swap):
//   z0–7.99  cluster nodes (stacked station badges, color = live max wind)
//   z8+      individual stations (station badge + neutral speed pill + arrow)
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
import { needsBaseReload, readingsMatchBase } from './stations-version';

import type * as maplibregl from 'maplibre-gl';

const SOURCE_BASE = 'windy-stations-base'; // live-cluster: nodes + all stations
const SOURCE_LIVE = 'windy-stations'; // stations with a current reading (pills)
const SOURCE_NODES = 'windy-stations-nodes'; // cluster nodes + live max wind

export const LAYER_ID_DOTS = 'windy-stations-dots';
export const LAYER_ID_SELECTION_PILL = 'windy-stations-selection-pill';
export const LAYER_ID_PILL = 'windy-stations-pill';
export const LAYER_ID_ARROW = 'windy-stations-arrow';
export const LAYER_ID_BADGE = 'windy-stations-badge';

const ARROW_IMAGE_ID_DARK = 'windy-station-arrow-dark';
const PILL_IMAGE_ID = 'windy-station-pill';
const SELECTION_PILL_IMAGE_ID = 'windy-station-selection-pill';
const BADGE_IMAGE_PREFIX = 'windy-station-badge-';

// Same-origin default — the /stations/* Pages Function proxies + edge-caches
// the public GCS objects. Overridable via setWindyStationsConfig for dev.
const DEFAULT_STATIONS_BASE_URL = '/stations';
const LIVE_CLUSTER_FILE = 'live-cluster.json';
const READINGS_FILE = 'readings.json';

// The rendering ladder: individuals from the switch up, stacked-badge node
// tiers below. Each tier's zoom band starts where its grid's cell spacing
// safely exceeds the widest stack (~46px), so stacks never overlap: z3 cells
// are ≥64px at z1, z5 cells ≥128px at z4, z8 cells ≥64px at z6.
const SWITCH_ZOOM = 8;
type NodeTier = {
	grid: number;
	minZoom: number;
	maxZoom: number;
	/** Legacy files carry ungridded nodes — only the z8 tier accepts them. */
	acceptsLegacy?: boolean;
};
const NODE_TIERS: NodeTier[] = [
	{ grid: 3, minZoom: 0, maxZoom: 4 },
	{ grid: 5, minZoom: 4, maxZoom: 6 },
	{ grid: 8, minZoom: 6, maxZoom: SWITCH_ZOOM, acceptsLegacy: true }
];
const nodeLayerId = (grid: number): string => `windy-stations-nodes-z${grid}`;
const NODE_LAYER_IDS = NODE_TIERS.map((t) => nodeLayerId(t.grid));
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
// The positions file loaded at least once (baseVersion alone can't tell: legacy files have no v).
let baseLoaded = false;
let baseIndex = new Map<string, BaseStation>();
let liveIds = new Set<string>(); // ids with feature-state applied (for cleanup)
let nodeFeatures: LiveClusterFeature[] = []; // nodes from the live-cluster
let nodeKts = new Map<string, number>(); // cell id → live max wind
let selectedStationId: string | number | null = null;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let pendingAbort: AbortController | undefined;
let visibilityListener: (() => void) | undefined;

const stationsBaseUrl = (): string =>
	(currentConfig.stationsBaseUrl ?? DEFAULT_STATIONS_BASE_URL).replace(/\/$/, '');

const getSource = (map: maplibregl.Map, id: string): maplibregl.GeoJSONSource | undefined =>
	map.getSource(id) as maplibregl.GeoJSONSource | undefined;

// ── image atlas ────────────────────────────────────────────────────────────

// Slim chevron, no outline — sits inside the neutral pill, so it is drawn in
// the pill's dark text colour. Points UP at icon-rotate=0.
const ARROW_SIZE = 12;
const PILL_TEXT_COLOR = '#1a1a2e';
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
	if (map.hasImage(ARROW_IMAGE_ID_DARK)) return;
	const dark = drawArrow(PILL_TEXT_COLOR);
	if (dark) {
		map.addImage(ARROW_IMAGE_ID_DARK, {
			width: ARROW_SIZE,
			height: ARROW_SIZE,
			data: new Uint8Array(dark.data)
		});
	}
};

// Capsule behind the arrow + speed. The wind colour lives on the badge, so the
// pill is one neutral white image; stretchX lets `icon-text-fit: 'both'` wrap
// 1- and 2-digit speeds while the round caps stay fixed.
const PILL_W = 36;
const PILL_H = 22;
const PILL_R = PILL_H / 2;

const capsulePath = (ctx: CanvasRenderingContext2D, inset: number): void => {
	const r = PILL_R - inset;
	ctx.beginPath();
	if (typeof ctx.roundRect === 'function') {
		ctx.roundRect(inset, inset, PILL_W - inset * 2, PILL_H - inset * 2, r);
	} else {
		ctx.moveTo(PILL_R, inset);
		ctx.lineTo(PILL_W - PILL_R, inset);
		ctx.arc(PILL_W - PILL_R, PILL_R, r, -Math.PI / 2, Math.PI / 2);
		ctx.lineTo(PILL_R, PILL_H - inset);
		ctx.arc(PILL_R, PILL_R, r, Math.PI / 2, (3 * Math.PI) / 2);
		ctx.closePath();
	}
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

const ensurePillImage = (map: maplibregl.Map): void => {
	if (map.hasImage(PILL_IMAGE_ID)) return;
	const canvas = document.createElement('canvas');
	canvas.width = PILL_W;
	canvas.height = PILL_H;
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	capsulePath(ctx, 0.5);
	ctx.fillStyle = '#ffffff';
	ctx.fill();
	// Hairline edge keeps the white pill distinct on pale map areas.
	ctx.strokeStyle = 'rgba(26,26,46,0.14)';
	ctx.lineWidth = 1;
	ctx.stroke();
	addStretchableImage(map, PILL_IMAGE_ID, ctx.getImageData(0, 0, PILL_W, PILL_H));
};

// Selection halo — a solid cyan capsule rendered behind the main pill; the
// layer pads it 2px more per side, so the halo is a constant 2px at any width.
const ensureSelectionPillImage = (map: maplibregl.Map): void => {
	if (map.hasImage(SELECTION_PILL_IMAGE_ID)) return;
	const canvas = document.createElement('canvas');
	canvas.width = PILL_W;
	canvas.height = PILL_H;
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	capsulePath(ctx, 0);
	ctx.fillStyle = '#22d3ee';
	ctx.fill();
	addStretchableImage(map, SELECTION_PILL_IMAGE_ID, ctx.getImageData(0, 0, PILL_W, PILL_H));
};

// Station badge — wind-coloured disc + tail with a white ring and the
// tower-broadcast glyph (the app's stations toggle icon), so a marker reads as
// "a station" rather than a map label. One image per (variant, wind band). The
// tail tip is the image's bottom-centre and the layers use icon-anchor
// 'bottom', so the tip lands on the station (or node) coordinates. Rendered at
// SCALE× with a matching pixelRatio so the glyph stays crisp.
const BADGE_SCALE = 3;
const BADGE_R = 11;
const BADGE_RING = 1.75;
const BADGE_CY = 14; // circle centre, from the top
const BADGE_TAIL = 8; // tail length below the circle
const BADGE_W = 28;
const BADGE_H = BADGE_CY + BADGE_R + BADGE_TAIL + 2;
// Stacks: extra discs peek out to the left of the front badge, like an avatar
// row, so a node reads as "several stations" without a count. The image is
// widened symmetrically so its bottom-centre (the anchor) stays under the
// front badge's tail.
const STACK_STEP = 6;
const BADGE_TEAL = '#0F8FA0';
const DARK_GLYPH_BANDS = new Set([4, 5]); // 20–30 kt: yellow/orange fills
type BadgeVariant = 'pws' | 'verified' | 'stack2' | 'stack3';
const BADGE_VARIANTS: BadgeVariant[] = ['pws', 'verified', 'stack2', 'stack3'];
const STACK_DEPTH: Record<BadgeVariant, number> = { pws: 1, verified: 1, stack2: 2, stack3: 3 };
const DIM_BAND = 'dim'; // nodes without a live reading
// Pill + arrow sit level with the badge's circle, starting under its right
// edge. Horizontal shift in px from the station point to the arrow.
const MARKER_DX = 20;
const MARKER_DY = -(BADGE_H - BADGE_CY);
const PILL_TEXT_SIZE = 12;
// Text-offset (ems) that moves the speed number — and with it the
// icon-text-fit pill — from the point onto the badge's right.
const PILL_TEXT_OFFSET: [number, number] = [
	0.6 + MARKER_DX / PILL_TEXT_SIZE,
	0.05 + MARKER_DY / PILL_TEXT_SIZE
];

// Tower-broadcast glyph from primitives, designed at a 14px radius and scaled
// to the badge: mast dot + stem, inner and outer signal arcs either side.
const drawTowerGlyph = (
	ctx: CanvasRenderingContext2D,
	cx: number,
	cy: number,
	color: string
): void => {
	ctx.save();
	ctx.translate(cx, cy);
	ctx.scale(BADGE_R / 14, BADGE_R / 14);
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineCap = 'round';
	ctx.beginPath();
	ctx.arc(0, -1, 2.2, 0, Math.PI * 2);
	ctx.fill();
	ctx.lineWidth = 1.8;
	ctx.beginPath();
	ctx.moveTo(0, 1);
	ctx.lineTo(0, 8);
	ctx.stroke();
	const arcs: [number, number, number][] = [
		[6, 1.6, 1],
		[10, 1.4, 0.65]
	];
	for (const [r, w, alpha] of arcs) {
		ctx.globalAlpha = alpha;
		ctx.lineWidth = w;
		ctx.beginPath();
		ctx.arc(0, -1, r, Math.PI * 0.75, Math.PI * 1.25);
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(0, -1, r, -Math.PI * 0.25, Math.PI * 0.25);
		ctx.stroke();
	}
	ctx.restore();
};

const ringed = (ctx: CanvasRenderingContext2D, path: Path2D, fill: string): void => {
	ctx.fillStyle = fill;
	ctx.fill(path);
	ctx.strokeStyle = '#ffffff';
	ctx.lineWidth = BADGE_RING;
	ctx.lineJoin = 'round';
	ctx.stroke(path);
};

// Small check dot on the badge's top-right for official networks: teal disc,
// white tick, white ring.
const drawVerifiedDot = (ctx: CanvasRenderingContext2D, cx: number, cy: number): void => {
	const x = cx + BADGE_R * 0.72;
	const y = cy - BADGE_R * 0.72;
	const dot = new Path2D();
	dot.arc(x, y, 4.2, 0, Math.PI * 2);
	ringed(ctx, dot, BADGE_TEAL);
	ctx.strokeStyle = '#ffffff';
	ctx.lineWidth = 1.3;
	ctx.lineCap = 'round';
	ctx.beginPath();
	ctx.moveTo(x - 1.8, y);
	ctx.lineTo(x - 0.4, y + 1.4);
	ctx.lineTo(x + 1.9, y - 1.3);
	ctx.stroke();
};

const bandFill = (band: number | typeof DIM_BAND): string => {
	if (band === DIM_BAND) return DIM_COLOR;
	const [, r, g, b] = COLOR_ANCHORS[band];
	return `rgb(${r},${g},${b})`;
};

const drawBadge = (variant: BadgeVariant, band: number | typeof DIM_BAND): ImageData | null => {
	const fill = bandFill(band);
	const depth = STACK_DEPTH[variant];
	const pad = STACK_STEP * (depth - 1);
	const w = BADGE_W + pad * 2;
	const canvas = document.createElement('canvas');
	canvas.width = w * BADGE_SCALE;
	canvas.height = BADGE_H * BADGE_SCALE;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.scale(BADGE_SCALE, BADGE_SCALE);
	const cx = w / 2;
	// Back discs first (furthest left), so each ring overlaps the one behind.
	for (let i = depth - 1; i >= 1; i--) {
		const back = new Path2D();
		back.arc(cx - STACK_STEP * i, BADGE_CY, BADGE_R, 0, Math.PI * 2);
		ringed(ctx, back, fill);
	}
	const pin = new Path2D();
	pin.arc(cx, BADGE_CY, BADGE_R, Math.PI * 0.62, Math.PI * 0.38);
	pin.lineTo(cx, BADGE_CY + BADGE_R + BADGE_TAIL);
	pin.closePath();
	ringed(ctx, pin, fill);
	const darkGlyph = band !== DIM_BAND && DARK_GLYPH_BANDS.has(band);
	drawTowerGlyph(ctx, cx, BADGE_CY, darkGlyph ? PILL_TEXT_COLOR : '#ffffff');
	if (variant === 'verified') drawVerifiedDot(ctx, cx, BADGE_CY);
	return ctx.getImageData(0, 0, w * BADGE_SCALE, BADGE_H * BADGE_SCALE);
};

const ensureBadgeImages = (map: maplibregl.Map): void => {
	const bands: (number | typeof DIM_BAND)[] = [...COLOR_ANCHORS.keys(), DIM_BAND];
	for (const variant of BADGE_VARIANTS) {
		for (const band of bands) {
			const id = `${BADGE_IMAGE_PREFIX}${variant}-${band}`;
			if (map.hasImage(id)) continue;
			const img = drawBadge(variant, band);
			if (!img) continue;
			map.addImage(
				id,
				{ width: img.width, height: img.height, data: new Uint8Array(img.data) },
				{ pixelRatio: BADGE_SCALE }
			);
		}
	}
};

// Step expression → wind band index (into COLOR_ANCHORS) for a speed in kt.
const bandIndexExpr = (speedExpr: unknown): unknown[] => {
	const expr: unknown[] = ['step', speedExpr, 0];
	for (let i = 1; i < COLOR_ANCHORS.length; i++) expr.push(COLOR_ANCHORS[i][0], i);
	return expr;
};

const badgeImageExpr = (variantExpr: unknown, bandExpr: unknown): unknown[] => [
	'concat',
	BADGE_IMAGE_PREFIX,
	variantExpr,
	'-',
	bandExpr
];

// ── layers ─────────────────────────────────────────────────────────────────

const ensureLayers = (map: maplibregl.Map): void => {
	ensureArrowImage(map);
	ensurePillImage(map);
	ensureSelectionPillImage(map);
	ensureBadgeImages(map);

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
	// Live source: only stations with a current reading — feeds the badge/
	// pill/arrow symbol layers at z8+. Rebuilt on each readings refresh.
	if (!map.getSource(SOURCE_LIVE)) {
		map.addSource(SOURCE_LIVE, {
			type: 'geojson',
			data: emptyFc,
			cluster: false,
			promoteId: 'id'
		});
	}
	// Node source: the pre-baked nodes with their live max wind as a property.
	// The stack image is chosen per wind band in layout, which feature-state
	// can't drive, so this small source is rebuilt on each readings refresh.
	if (!map.getSource(SOURCE_NODES)) {
		map.addSource(SOURCE_NODES, {
			type: 'geojson',
			data: emptyFc,
			cluster: false,
			promoteId: 'id'
		});
	}

	// Cluster nodes — a stack of station badges coloured by the node's live
	// max wind, dimmed without a reading. Two discs for a pair, three for
	// more; a single station shows one badge. One layer per pre-baked tier;
	// a tier missing from the file matches nothing via its grid filter, and
	// loadBase extends the next finer tier's zoom range down over the gap.
	for (const tier of NODE_TIERS) {
		const gridMatch = tier.acceptsLegacy
			? // Legacy files carry ungridded nodes — fold them into this tier.
				['any', ['!', ['has', 'grid']], ['==', ['get', 'grid'], tier.grid]]
			: ['==', ['get', 'grid'], tier.grid];
		if (!map.getLayer(nodeLayerId(tier.grid))) {
			map.addLayer({
				id: nodeLayerId(tier.grid),
				type: 'symbol',
				source: SOURCE_NODES,
				minzoom: tier.minZoom,
				maxzoom: tier.maxZoom,
				filter: gridMatch as never,
				layout: {
					'icon-image': badgeImageExpr(
						[
							'case',
							['>=', ['coalesce', ['get', 'count'], 1], 3],
							'stack3',
							['==', ['coalesce', ['get', 'count'], 1], 2],
							'stack2',
							'pws'
						],
						['case', ['has', 'kts'], ['to-string', bandIndexExpr(['get', 'kts'])], DIM_BAND]
					) as never,
					'icon-anchor': 'bottom',
					'icon-allow-overlap': true,
					'icon-ignore-placement': true
				}
			});
		}
	}

	// Station dots — z8+, every station from the base file. Colored when a
	// live reading exists (feature-state), dimmed otherwise. Hidden (opacity
	// 0) when the station has a badge, so silent stations are exactly the
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
				'circle-opacity': ['case', ['boolean', ['feature-state', 'live'], false], 0, 0.55] as never
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
				'icon-text-fit-padding': [4, 9, 4, 22],
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
				'text-field': ['to-string', ['get', 'windKtsRounded']] as never,
				'text-font': ['Noto Sans Regular'],
				'text-size': PILL_TEXT_SIZE,
				'text-anchor': 'left',
				'text-offset': PILL_TEXT_OFFSET,
				'text-allow-overlap': true,
				'text-ignore-placement': true
			},
			paint: {
				'icon-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0],
				'text-opacity': 0
			}
		});
	}

	// Neutral pill with the wind speed, off the badge's right. Individuals
	// only — per the architecture decision nodes show no numbers or arrows.
	if (!map.getLayer(LAYER_ID_PILL)) {
		map.addLayer({
			id: LAYER_ID_PILL,
			type: 'symbol',
			source: SOURCE_LIVE,
			minzoom: SWITCH_ZOOM,
			layout: {
				'icon-image': PILL_IMAGE_ID,
				'icon-text-fit': 'both',
				// Extra left pad reserves space for the rotated arrow.
				'icon-text-fit-padding': [2, 7, 2, 20],
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
				'text-field': ['to-string', ['get', 'windKtsRounded']] as never,
				'text-font': ['Noto Sans Regular'],
				'text-size': PILL_TEXT_SIZE,
				'text-anchor': 'left',
				'text-offset': PILL_TEXT_OFFSET,
				'text-allow-overlap': true,
				'text-ignore-placement': true
			},
			paint: {
				'text-color': PILL_TEXT_COLOR
			}
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
				'icon-image': ARROW_IMAGE_ID_DARK,
				'icon-rotate': ['+', ['get', 'windDir'], 180] as never,
				'icon-rotation-alignment': 'map',
				'icon-size': 1,
				'icon-allow-overlap': true,
				'icon-ignore-placement': true
			},
			// Screen-space shift onto the pill. icon-offset can't be used here:
			// it is applied in the icon's rotated frame, so it would orbit the
			// point with the wind direction.
			paint: {
				'icon-translate': [MARKER_DX, MARKER_DY],
				'icon-translate-anchor': 'viewport'
			}
		});
	}

	// Station badge — drawn last so the pill tucks under its right edge.
	// Official networks (priority 0 in the live-cluster: metar/ndbc/knmi) get
	// the check dot; PWS, push and other community stations don't.
	if (!map.getLayer(LAYER_ID_BADGE)) {
		map.addLayer({
			id: LAYER_ID_BADGE,
			type: 'symbol',
			source: SOURCE_LIVE,
			minzoom: SWITCH_ZOOM,
			layout: {
				'icon-image': badgeImageExpr(
					['case', ['==', ['get', 'priority'], 0], 'verified', 'pws'],
					['to-string', bandIndexExpr(['get', 'windKts'])]
				) as never,
				'icon-anchor': 'bottom',
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

// `forReadingsV`: install the file only if it matches these readings. A reload
// that still returns another version keeps the current, consistent pair on screen.
const loadBase = async (
	map: maplibregl.Map,
	reload = false,
	forReadingsV?: number
): Promise<boolean> => {
	try {
		// `reload` fires on a version mismatch (nightly rotation, or a
		// format upgrade like SRF-2660). cache:'reload' busts the browser
		// cache; the header tells the /stations proxy to bypass its
		// Cloudflare edge cache too — without it, a stale edge entry (up to
		// 6h TTL) survives any client-side reload and the mismatch persists.
		const res = await fetch(`${stationsBaseUrl()}/${LIVE_CLUSTER_FILE}`, {
			cache: reload ? 'reload' : 'default',
			headers: reload ? { 'X-Surfr-Force-Refresh': '1' } : undefined
		});
		if (!res.ok) return false;
		const fc = (await res.json()) as GeoJSON.FeatureCollection & { v?: number };
		if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return false;
		const fileVersion = typeof fc.v === 'number' ? fc.v : null;
		if (forReadingsV !== undefined && !readingsMatchBase(fileVersion, forReadingsV)) return false;

		baseVersion = fileVersion;
		baseLoaded = true;
		baseIndex = new Map();
		nodeFeatures = [];
		const gridsInFile = new Set<number>();
		let hasLegacyNodes = false;
		for (const f of fc.features as LiveClusterFeature[]) {
			const p = f.properties;
			if (!p || !f.geometry) continue;
			if (p.node) {
				const grid = (p as { grid?: number }).grid;
				if (typeof grid === 'number') gridsInFile.add(grid);
				else hasLegacyNodes = true;
				nodeFeatures.push(f);
				continue;
			}
			baseIndex.set(p.id, {
				lon: f.geometry.coordinates[0],
				lat: f.geometry.coordinates[1],
				source: p.source ?? null,
				priority: p.priority ?? 1
			});
		}
		getSource(map, SOURCE_BASE)?.setData(fc);
		renderNodes(map);

		// Rollout fallback: older files may lack the coarser tiers (or carry
		// only ungridded legacy nodes, which the legacy-accepting tier
		// renders). Walk the ladder coarsest→finest and hand each missing
		// tier's zoom band to the next available finer tier, so no zoom range
		// ever renders nothing.
		let carryMin = 0;
		for (const tier of NODE_TIERS) {
			const available = gridsInFile.has(tier.grid) || (tier.acceptsLegacy && hasLegacyNodes);
			if (!available) continue; // its grid filter matches nothing anyway
			if (map.getLayer(nodeLayerId(tier.grid))) {
				map.setLayerZoomRange(nodeLayerId(tier.grid), carryMin, tier.maxZoom);
			}
			carryMin = tier.maxZoom;
		}
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

// Re-emit the nodes with their live max wind as a `kts` property (omitted
// without a reading, so the layer's `has kts` check picks the dim stack).
const renderNodes = (map: maplibregl.Map): void => {
	const features = nodeFeatures.map((f): GeoJSON.Feature => {
		const kts = nodeKts.get(f.properties.id);
		return {
			type: 'Feature',
			geometry: f.geometry,
			properties: kts == null ? f.properties : { ...f.properties, kts }
		};
	});
	getSource(map, SOURCE_NODES)?.setData({ type: 'FeatureCollection', features });
};

const applyReadings = (map: maplibregl.Map, readings: ReadingsFile): void => {
	const nowSec = Date.now() / 1000;
	const stations = readings.stations ?? {};
	const nodes = readings.nodes ?? {};

	// Node colors — the stack image follows the wind band.
	nodeKts = new Map(Object.entries(nodes));
	renderNodes(map);

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
		props.priority = base.priority;
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
		// No positions yet (the first load failed): load them first, or readings
		// have nothing to attach to. Every refresh retries until it succeeds.
		if (!baseLoaded && !(await loadBase(map))) return;

		const res = await fetch(`${stationsBaseUrl()}/${READINGS_FILE}`, {
			signal: pendingAbort.signal
		});
		if (!res.ok) return;
		const readings = (await res.json()) as ReadingsFile;

		// Version guard: the station set changed while we hold an older
		// live-cluster — refetch it, and install it plus the readings only if the
		// two agree. A failed reload, or the proxy serving another version (its
		// refresh cooldown), skips this round and leaves the current positions and
		// values on screen together; the next refresh retries.
		if (
			typeof readings.v === 'number' &&
			needsBaseReload(baseVersion, readings.v) &&
			!(await loadBase(map, true, readings.v))
		) {
			return;
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

	// The live-cluster carries no names. The app's station sheet fetches the
	// station (name, attribution, history) from the live-wind service by id, so
	// the map makes no extra request per tap.
	currentConfig.onStationTap?.(station);
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

const INTERACTIVE_STATION_LAYERS = [LAYER_ID_BADGE, LAYER_ID_PILL, LAYER_ID_ARROW, LAYER_ID_DOTS];

const attachInteractionHandlers = (map: maplibregl.Map): void => {
	for (const layerId of INTERACTIVE_STATION_LAYERS) {
		map.on('click', layerId, handleStationClick);
		map.on('mouseenter', layerId, setCursorPointer);
		map.on('mouseleave', layerId, setCursorDefault);
	}
	for (const layerId of NODE_LAYER_IDS) {
		map.on('click', layerId, handleNodeClick);
		map.on('mouseenter', layerId, setCursorPointer);
		map.on('mouseleave', layerId, setCursorDefault);
	}
};

const detachInteractionHandlers = (map: maplibregl.Map): void => {
	for (const layerId of INTERACTIVE_STATION_LAYERS) {
		map.off('click', layerId, handleStationClick);
		map.off('mouseenter', layerId, setCursorPointer);
		map.off('mouseleave', layerId, setCursorDefault);
	}
	for (const layerId of NODE_LAYER_IDS) {
		map.off('click', layerId, handleNodeClick);
		map.off('mouseenter', layerId, setCursorPointer);
		map.off('mouseleave', layerId, setCursorDefault);
	}
};

// ── public API (unchanged surface) ─────────────────────────────────────────

const ALL_LAYERS = [
	...NODE_LAYER_IDS,
	LAYER_ID_DOTS,
	LAYER_ID_SELECTION_PILL,
	LAYER_ID_PILL,
	LAYER_ID_ARROW,
	LAYER_ID_BADGE
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
		if (!baseLoaded) {
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
	getSource(map, SOURCE_NODES)?.setData(emptyFc);
	selectedStationId = null;
	baseIndex.clear();
	liveIds.clear();
	nodeFeatures = [];
	nodeKts.clear();
	baseVersion = null;
	baseLoaded = false;
	currentMap = null;
};
