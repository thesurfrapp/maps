import { get } from 'svelte/store';

import * as maplibregl from 'maplibre-gl';
import { mode } from 'mode-watcher';

import { map as m } from '$lib/stores/map';
import { defaultPreferences, preferences as p } from '$lib/stores/preferences';

import { BEFORE_LAYER_RASTER, HILLSHADE_LAYER } from '$lib/constants';

import { SettingsButton } from './components/buttons';
import { addOmFileLayers } from './layers';
import { updateUrl } from './url';

export const setMapControlSettings = ({ embed = false } = {}) => {
	const map = get(m);
	if (!map) return;

	map.touchZoomRotate.disableRotation();
	map.scrollZoom.setZoomRate(1 / 85);
	map.scrollZoom.setWheelZoomRate(1 / 85);

	// GlobeControl stays visible in both standalone and embed — we're using
	// it to debug the `setZoom -> flip to globe` path from the RN bridge.
	// If the control's button works but programmatic setGlobeProjection()
	// doesn't, the issue is in our helper, not MapLibre's projection API.
	const globeControl = new maplibregl.GlobeControl();
	map.addControl(globeControl);
	globeControl._globeButton.addEventListener('click', () => globeHandler());

	// In embed mode the RN app owns all other UI — don't render MapLibre's
	// NavigationControl / GeolocateControl or our SettingsButton.
	if (embed) return;

	map.addControl(
		new maplibregl.NavigationControl({ visualizePitch: true, showZoom: true, showCompass: true })
	);
	map.addControl(
		new maplibregl.GeolocateControl({
			fitBoundsOptions: { maxZoom: 13.5 },
			positionOptions: { enableHighAccuracy: true },
			trackUserLocation: true
		})
	);

	// Settings sheet trigger — kept on the standalone web UI only. RN app has
	// its own settings.
	map.addControl(new SettingsButton());
};

export const addTerrainSource = (map: maplibregl.Map, name: string = 'terrainSource') => {
	map.setSky({
		'sky-color': '#000000',
		'sky-horizon-blend': 0.8,
		'horizon-color': '#80C1FF',
		'horizon-fog-blend': 0.6,
		'fog-color': '#D6EAFF',
		'fog-ground-blend': 0
	});

	map.addSource(name, {
		type: 'raster-dem',
		url: 'https://tiles.mapterhorn.com/tilejson.json'
	});
};

export const addHillshadeLayer = () => {
	const map = get(m);
	if (!map) return;

	map.addLayer(
		{
			source: 'terrainSource',
			id: HILLSHADE_LAYER,
			type: 'hillshade',
			paint: {
				'hillshade-method': 'igor',
				'hillshade-shadow-color': 'rgba(0,0,0,0.4)',
				'hillshade-highlight-color': 'rgba(255,255,255,0.35)'
			}
		},
		BEFORE_LAYER_RASTER
	);
};

export const getStyle = async () => {
	const preferences = get(p);
	// OpenFreeMap basemap (CORS-open, OpenMapTiles-based). Upstream used
	// tiles.open-meteo.com which is CORS-allowlisted to Open-Meteo's own origins.
	// Positron for light, Dark for dark mode — minimalist styles that let the
	// weather overlay read clearly on top.
	const styleName = mode.current === 'dark' ? 'dark' : 'positron';
	const style = await fetch(`https://tiles.openfreemap.org/styles/${styleName}`).then((r) =>
		r.json()
	);

	// Minimal planet look matching maps.open-meteo.com so the weather overlay
	// dominates visually. Filter is source-layer based (cross-style) with a few
	// id-specific tweaks to cover both OpenFreeMap's `positron` and `dark` (which
	// use different layer id conventions).
	if (Array.isArray(style.layers)) {
		const HIDE_SOURCE_LAYERS = new Set([
			'transportation',
			'transportation_name',
			'building',
			'landcover',
			'landuse',
			'waterway',
			'aeroway',
			'park'
		]);
		const HIDE_IDS = new Set([
			// sub-national admin (dark + positron)
			'boundary_state',
			'boundary_3',
			'boundary_disputed',
			// micro-place labels
			'place_village',
			'place_suburb',
			'place_other'
		]);
		for (const layer of style.layers) {
			const id: string = layer?.id ?? '';
			const src: string = layer?.['source-layer'] ?? '';
			if (HIDE_SOURCE_LAYERS.has(src) || HIDE_IDS.has(id)) {
				layer.layout = { ...(layer.layout ?? {}), visibility: 'none' };
				continue;
			}
			// Country borders: bump color to white at full opacity. Also exclude
			// maritime features — OpenMapTiles' admin_level=2 layer includes
			// territorial-water / EEZ lines that draw weird offshore lines.
			// (Width left alone — upstream uses wide casings at high zoom that
			// blow up if we multiply.)
			if (id.startsWith('boundary_country') || id === 'boundary_2') {
				layer.paint = {
					...(layer.paint ?? {}),
					'line-color': '#ffffff',
					'line-opacity': 1
				};
				const existing = layer.filter;
				const noMaritime = ['!=', ['get', 'maritime'], 1] as unknown as maplibregl.FilterSpecification;
				layer.filter = (
					existing ? (['all', existing, noMaritime] as unknown) : noMaritime
				) as maplibregl.FilterSpecification;
			}

			// Place labels (countries, states, cities, towns): white, no halo.
			// Upstream's gray-with-halo reads muddy over our saturated weather
			// raster; we keep the basemap minimal so labels can be flat colour.
			if (src === 'place' && id.startsWith('place_')) {
				layer.paint = {
					...(layer.paint ?? {}),
					'text-color': '#ffffff',
					'text-halo-color': 'rgba(0,0,0,0)',
					'text-halo-width': 0,
					'text-halo-blur': 0
				};
			}
		}

		// Coastline layer — strokes water polygons in white. Real coastlines
		// (true land/water boundary). Restored after we removed it by mistake.
		const hasOpenmaptiles = Boolean(style.sources?.openmaptiles);
		if (hasOpenmaptiles && !style.layers.find((l: { id: string }) => l.id === 'surfr_coastline')) {
			const waterIdx = style.layers.findIndex((l: { id: string }) => l.id === 'water');
			const coastline = {
				id: 'surfr_coastline',
				type: 'line',
				source: 'openmaptiles',
				'source-layer': 'water',
				// Only ocean polygons — exclude rivers / lakes / ponds so we
				// trace true coastlines, not inland water rings.
				filter: [
					'all',
					['==', ['geometry-type'], 'Polygon'],
					['==', ['get', 'class'], 'ocean']
				],
				paint: {
					'line-color': '#ffffff',
					'line-opacity': 0.55,
					'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.4, 3, 0.7, 6, 1, 12, 1.4]
				}
			};
			if (waterIdx >= 0) {
				style.layers.splice(waterIdx + 1, 0, coastline);
			} else {
				style.layers.push(coastline);
			}
		}
	}

	return preferences.globe ? { ...style, projection: { type: 'globe' } } : style;
};

export const terrainHandler = () => {
	const preferences = get(p);
	preferences.terrain = !preferences.terrain;
	p.set(preferences);
	updateUrl('terrain', String(preferences.terrain), String(defaultPreferences.terrain));
};

export const globeHandler = () => {
	const preferences = get(p);
	preferences.globe = !preferences.globe;
	p.set(preferences);
	updateUrl('globe', String(preferences.globe), String(defaultPreferences.globe));
};

// Programmatically flip projection + persist preference — mirrors what
// MapLibre's built-in GlobeControl does when its button is clicked, but
// callable from anywhere (e.g. the RN bridge's setZoom handler).
export const setGlobeProjection = (globe: boolean) => {
	const preferences = get(p);
	if (preferences.globe === globe) return;
	const map = get(m);
	if (map) {
		try {
			map.setProjection({ type: globe ? 'globe' : 'mercator' });
		} catch (err) {
			console.warn('[setGlobeProjection] setProjection failed', err);
		}
	}
	preferences.globe = globe;
	p.set(preferences);
	updateUrl('globe', String(globe), String(defaultPreferences.globe));
};

export const reloadStyles = () => {
	getStyle().then((style) => {
		const map = get(m);
		if (!map) return;
		map.setStyle(style);
		map.once('styledata', () => {
			setTimeout(() => {
				addTerrainSource(map);
				const preferences = get(p);
				if (preferences.hillshade) {
					addHillshadeLayer();
				}
				addOmFileLayers();
			}, 50);
		});
	});
};
