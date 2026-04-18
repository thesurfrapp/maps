// Render Surfr spots (the user's saved surf/kite locations) on the map as
// little cyan dots + labels at mid+ zoom levels. Data comes from the Surfr
// backend's bbox endpoint; the host (RN WebView or CLI config) supplies the
// endpoint URL + access token.
//
// Mirror of the UX that the old WindyMapView had before we replaced it.

import type * as maplibregl from 'maplibre-gl';

const SOURCE_ID = 'surfr-spots';
export const LAYER_ID_DOT = 'surfr-spots-dot';
const LAYER_ID_LABEL = 'surfr-spots-label';
const MIN_ZOOM = 8;
const LIMIT = 100;
const DEBOUNCE_MS = 500;

type SpotsConfig = {
	endpoint?: string; // e.g. https://api.thesurfr.app
	token?: string;
};

type Spot = {
	id?: string | number;
	lat: number | string;
	lon: number | string;
	name?: string;
};

const emptyFc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

let currentMap: maplibregl.Map | null = null;
let currentConfig: SpotsConfig = {};
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let pendingAbort: AbortController | undefined;

const getSource = (map: maplibregl.Map): maplibregl.GeoJSONSource | undefined =>
	map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;

const ensureLayers = (map: maplibregl.Map): void => {
	if (!map.getSource(SOURCE_ID)) {
		map.addSource(SOURCE_ID, { type: 'geojson', data: emptyFc });
	}
	if (!map.getLayer(LAYER_ID_DOT)) {
		map.addLayer({
			id: LAYER_ID_DOT,
			type: 'circle',
			source: SOURCE_ID,
			minzoom: MIN_ZOOM,
			paint: {
				'circle-radius': 4,
				'circle-color': '#22d3ee',
				'circle-stroke-color': 'rgba(255,255,255,0.6)',
				'circle-stroke-width': 1.25
			}
		});
	}
	if (!map.getLayer(LAYER_ID_LABEL)) {
		map.addLayer({
			id: LAYER_ID_LABEL,
			type: 'symbol',
			source: SOURCE_ID,
			minzoom: MIN_ZOOM,
			layout: {
				'text-field': ['get', 'name'],
				'text-font': ['Noto Sans Regular'],
				'text-size': 11,
				'text-offset': [0, 0.9],
				'text-anchor': 'top',
				'text-padding': 2,
				'text-allow-overlap': false,
				'text-ignore-placement': false
			},
			paint: {
				'text-color': '#ffffff',
				'text-halo-color': 'rgba(0,0,0,0.75)',
				'text-halo-width': 1.2
			}
		});
	}
};

const toFeatureCollection = (spots: Spot[]): GeoJSON.FeatureCollection => ({
	type: 'FeatureCollection',
	features: spots
		.map((s): GeoJSON.Feature | null => {
			const lat = typeof s.lat === 'string' ? parseFloat(s.lat) : s.lat;
			const lon = typeof s.lon === 'string' ? parseFloat(s.lon) : s.lon;
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
			return {
				type: 'Feature',
				geometry: { type: 'Point', coordinates: [lon, lat] },
				properties: { id: s.id ?? null, name: s.name ?? '' }
			};
		})
		.filter((f): f is GeoJSON.Feature => f !== null)
});

const clearSpots = (map: maplibregl.Map): void => {
	getSource(map)?.setData(emptyFc);
};

const fetchAndRender = async (map: maplibregl.Map, config: SpotsConfig): Promise<void> => {
	if (!config.endpoint || !config.token) return;
	if (map.getZoom() < MIN_ZOOM) {
		clearSpots(map);
		return;
	}
	const bounds = map.getBounds();
	const url =
		`${config.endpoint.replace(/\/$/, '')}/spots/bbox` +
		`?accesstoken=${encodeURIComponent(config.token)}` +
		`&minlat=${bounds.getSouth()}` +
		`&maxlat=${bounds.getNorth()}` +
		`&minlon=${bounds.getWest()}` +
		`&maxlon=${bounds.getEast()}` +
		`&limit=${LIMIT}`;

	// Cancel any pending fetch; only the latest viewport matters.
	pendingAbort?.abort();
	pendingAbort = new AbortController();
	try {
		const res = await fetch(url, { signal: pendingAbort.signal });
		if (!res.ok) return;
		const spots = (await res.json()) as Spot[];
		if (!Array.isArray(spots)) return;
		ensureLayers(map);
		getSource(map)?.setData(toFeatureCollection(spots));
	} catch (e) {
		if ((e as Error).name === 'AbortError') return;
		console.warn('[surfr-spots] fetch failed', e);
	}
};

const debounced = (map: maplibregl.Map) => {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => fetchAndRender(map, currentConfig), DEBOUNCE_MS);
};

const onMoveEnd = (): void => {
	if (currentMap) debounced(currentMap);
};

export const initSurfrSpots = (map: maplibregl.Map): void => {
	currentMap = map;
	ensureLayers(map);
	map.on('moveend', onMoveEnd);
	// Fire an initial fetch if config is already set when the map loads.
	fetchAndRender(map, currentConfig);
};

export const setSurfrSpotsConfig = (config: SpotsConfig): void => {
	currentConfig = { ...currentConfig, ...config };
	if (currentMap) fetchAndRender(currentMap, currentConfig);
};

export const teardownSurfrSpots = (map: maplibregl.Map): void => {
	map.off('moveend', onMoveEnd);
	pendingAbort?.abort();
	pendingAbort = undefined;
	if (debounceTimer) {
		clearTimeout(debounceTimer);
		debounceTimer = undefined;
	}
	currentMap = null;
};
