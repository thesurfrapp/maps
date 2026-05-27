// Render live wind station data from the Surfr backend on the map.
//
// Uses a clustered GeoJSON source + circle/symbol layers (mirrors the pattern
// already established in surfr-spots.ts). At low zoom, stations aggregate into
// count bubbles colored by average wind speed. At medium+ zoom, individual
// stations render as colored dots with a small white arrow indicating wind
// direction (pointing downwind, away from the station). Speed numbers appear
// at zoom 11+. Source hierarchy (KNMI/METAR/NDBC vs Windy PWS) is conveyed
// through dot size and stroke weight, not via badges.
//
// Replaces the previous DOM-marker-per-station approach which could not
// cluster and became unreadable in dense regions (NL/DE/BE) at country zoom.
//
// API surface preserved: initWindyStations, setWindyStationsConfig,
// setWindyStationsVisible, teardownWindyStations. rn-bridge.ts and
// overlay-pills.svelte do not need to change.
import type * as maplibregl from 'maplibre-gl';

const SOURCE_ID = 'windy-stations';
export const LAYER_ID_CLUSTERS = 'windy-stations-clusters';
export const LAYER_ID_CLUSTER_COUNT = 'windy-stations-cluster-count';
export const LAYER_ID_DOT = 'windy-stations-dot';
export const LAYER_ID_ARROW = 'windy-stations-arrow';
export const LAYER_ID_LABEL = 'windy-stations-label';
const ARROW_IMAGE_ID = 'windy-station-arrow';

const MIN_ZOOM = 5;
// Bumped from 200 — clustering aggregates client-side, so the backend needs to
// send enough raw points for cluster counts to be representative at country
// zoom. Backend already dedups within 2km, so the realistic visible-bbox cap
// for individual stations is well below this.
const LIMIT = 500;
const DEBOUNCE_MS = 700;
const CLUSTER_MAX_ZOOM = 9;
const CLUSTER_RADIUS = 50;
const LABEL_MIN_ZOOM = 11;

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

// Register a small white triangle with a faint dark outline. The triangle
// points UP at icon-rotate=0; the layer applies (windDir + 180) so it ends up
// pointing downwind, offset to the downwind side of the dot.
const ensureArrowImage = (map: maplibregl.Map): void => {
	if (map.hasImage(ARROW_IMAGE_ID)) return;
	const size = 12;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	ctx.fillStyle = '#ffffff';
	ctx.beginPath();
	ctx.moveTo(size / 2, 0); // tip
	ctx.lineTo(size - 1, size - 1); // bottom-right
	ctx.lineTo(size / 2, size * 0.65); // notch (gives the chevron silhouette)
	ctx.lineTo(1, size - 1); // bottom-left
	ctx.closePath();
	ctx.fill();
	ctx.strokeStyle = 'rgba(0,0,0,0.45)';
	ctx.lineWidth = 0.5;
	ctx.stroke();
	const imageData = ctx.getImageData(0, 0, size, size);
	map.addImage(ARROW_IMAGE_ID, {
		width: size,
		height: size,
		data: new Uint8Array(imageData.data)
	});
};

const ensureLayers = (map: maplibregl.Map): void => {
	ensureArrowImage(map);

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
				// painting to get the average speed used for cluster color.
				sumKts: ['+', ['get', 'windKts']]
			}
		});
	}

	// Cluster bubble — radius interpolates from 12 (small cluster) to 28
	// (250+ stations). Color uses the same wind ramp as the GFS background
	// so it reads as "average local wind speed".
	if (!map.getLayer(LAYER_ID_CLUSTERS)) {
		map.addLayer({
			id: LAYER_ID_CLUSTERS,
			type: 'circle',
			source: SOURCE_ID,
			minzoom: MIN_ZOOM,
			filter: ['has', 'point_count'],
			paint: {
				'circle-radius': [
					'interpolate',
					['linear'],
					['get', 'point_count'],
					2,
					12,
					10,
					16,
					50,
					22,
					250,
					28
				],
				'circle-color': [
					'interpolate',
					['linear'],
					['/', ['get', 'sumKts'], ['get', 'point_count']],
					...buildColorStops()
				],
				'circle-opacity': 0.85,
				'circle-stroke-color': 'rgba(255,255,255,0.7)',
				'circle-stroke-width': 1.5
			}
		});
	}

	if (!map.getLayer(LAYER_ID_CLUSTER_COUNT)) {
		map.addLayer({
			id: LAYER_ID_CLUSTER_COUNT,
			type: 'symbol',
			source: SOURCE_ID,
			minzoom: MIN_ZOOM,
			filter: ['has', 'point_count'],
			layout: {
				'text-field': ['get', 'point_count_abbreviated'],
				'text-font': ['Noto Sans Regular'],
				'text-size': 12,
				'text-allow-overlap': true,
				'text-ignore-placement': true
			},
			paint: {
				'text-color': '#ffffff',
				'text-halo-color': 'rgba(0,0,0,0.55)',
				'text-halo-width': 1
			}
		});
	}

	// Individual station dot. Radius encodes source hierarchy: official
	// sources (KNMI/METAR/NDBC) are noticeably larger than PWS. Selection
	// state (via map.setFeatureState) enlarges and switches the stroke to
	// the cyan accent used elsewhere in the embed (matches surfr-spots
	// selection pulse color).
	if (!map.getLayer(LAYER_ID_DOT)) {
		map.addLayer({
			id: LAYER_ID_DOT,
			type: 'circle',
			source: SOURCE_ID,
			minzoom: MIN_ZOOM,
			filter: ['!', ['has', 'point_count']],
			paint: {
				'circle-radius': [
					'case',
					['boolean', ['feature-state', 'selected'], false],
					9,
					['==', ['get', 'source'], 'pws'],
					4,
					5.5
				],
				'circle-color': ['interpolate', ['linear'], ['get', 'windKts'], ...buildColorStops()],
				'circle-opacity': 1,
				'circle-stroke-color': [
					'case',
					['boolean', ['feature-state', 'selected'], false],
					'#22d3ee',
					'rgba(255,255,255,0.85)'
				],
				'circle-stroke-width': [
					'case',
					['boolean', ['feature-state', 'selected'], false],
					2,
					['==', ['get', 'source'], 'pws'],
					0.75,
					1.25
				]
			}
		});
	}

	// Wind direction arrow. icon-offset is applied in icon-local space, so
	// it rotates with icon-rotate — the triangle ends up tangent to the dot
	// on the downwind side, pointing further downwind. Across many stations
	// this reads as a vector field (like iron filings).
	if (!map.getLayer(LAYER_ID_ARROW)) {
		map.addLayer({
			id: LAYER_ID_ARROW,
			type: 'symbol',
			source: SOURCE_ID,
			minzoom: MIN_ZOOM,
			filter: ['all', ['!', ['has', 'point_count']], ['has', 'windDir']],
			layout: {
				'icon-image': ARROW_IMAGE_ID,
				'icon-rotate': ['+', ['get', 'windDir'], 180],
				'icon-rotation-alignment': 'map',
				'icon-size': 1,
				'icon-offset': [0, -10],
				'icon-allow-overlap': true,
				'icon-ignore-placement': true
			}
		});
	}

	// Speed label appears only at zoom 11+, anchored to the right of the
	// dot. text-allow-overlap is false so the label-placement engine handles
	// crowding gracefully (drops labels rather than overlapping them).
	if (!map.getLayer(LAYER_ID_LABEL)) {
		map.addLayer({
			id: LAYER_ID_LABEL,
			type: 'symbol',
			source: SOURCE_ID,
			minzoom: LABEL_MIN_ZOOM,
			filter: ['!', ['has', 'point_count']],
			layout: {
				'text-field': ['to-string', ['get', 'windKtsRounded']],
				'text-font': ['Noto Sans Regular'],
				'text-size': 11,
				'text-offset': [0.9, 0.15],
				'text-anchor': 'left',
				'text-allow-overlap': false,
				'text-ignore-placement': false,
				'text-padding': 2
			},
			paint: {
				'text-color': '#ffffff',
				'text-halo-color': 'rgba(0,0,0,0.75)',
				'text-halo-width': 1.2
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
						source: s.source
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

const attachInteractionHandlers = (map: maplibregl.Map): void => {
	map.on('click', LAYER_ID_DOT, handleStationClick);
	map.on('click', LAYER_ID_CLUSTERS, handleClusterClick);
	map.on('mouseenter', LAYER_ID_DOT, setCursorPointer);
	map.on('mouseleave', LAYER_ID_DOT, setCursorDefault);
	map.on('mouseenter', LAYER_ID_CLUSTERS, setCursorPointer);
	map.on('mouseleave', LAYER_ID_CLUSTERS, setCursorDefault);
};

const detachInteractionHandlers = (map: maplibregl.Map): void => {
	map.off('click', LAYER_ID_DOT, handleStationClick);
	map.off('click', LAYER_ID_CLUSTERS, handleClusterClick);
	map.off('mouseenter', LAYER_ID_DOT, setCursorPointer);
	map.off('mouseleave', LAYER_ID_DOT, setCursorDefault);
	map.off('mouseenter', LAYER_ID_CLUSTERS, setCursorPointer);
	map.off('mouseleave', LAYER_ID_CLUSTERS, setCursorDefault);
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
		LAYER_ID_CLUSTERS,
		LAYER_ID_CLUSTER_COUNT,
		LAYER_ID_DOT,
		LAYER_ID_ARROW,
		LAYER_ID_LABEL
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
