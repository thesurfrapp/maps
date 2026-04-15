import { get } from 'svelte/store';

import * as maplibregl from 'maplibre-gl';
import { mode } from 'mode-watcher';

import { map as m } from '$lib/stores/map';
import { defaultPreferences, preferences as p } from '$lib/stores/preferences';

import { BEFORE_LAYER_RASTER, HILLSHADE_LAYER } from '$lib/constants';

import { addOmFileLayers } from './layers';
import { updateUrl } from './url';

export const setMapControlSettings = () => {
	const map = get(m);
	if (!map) return;

	map.touchZoomRotate.disableRotation();
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

	const globeControl = new maplibregl.GlobeControl();
	map.addControl(globeControl);
	globeControl._globeButton.addEventListener('click', () => globeHandler());

	map.scrollZoom.setZoomRate(1 / 85);
	map.scrollZoom.setWheelZoomRate(1 / 85);
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
			// Country borders — both styles. `boundary_country_*` is dark;
			// `boundary_2` is positron. Keep the upstream zoom-interpolated
			// line-width so borders stay appropriately scaled; just force full
			// white + opacity. Explicitly clear any dash pattern to solid.
			if (id.startsWith('boundary_country') || id === 'boundary_2') {
				const upstreamWidth = layer.paint?.['line-width'];
				layer.paint = {
					...(layer.paint ?? {}),
					'line-color': '#ffffff',
					'line-opacity': 1,
					// scale upstream width up by ~1.6x for visibility over weather
					'line-width': Array.isArray(upstreamWidth)
						? [
								'interpolate',
								['linear'],
								['zoom'],
								0,
								1.5,
								3,
								2,
								5,
								2.5,
								12,
								4.5
							]
						: 2.5
				};
				// Ensure no dash pattern bleeds in
				if ('line-dasharray' in (layer.paint as Record<string, unknown>)) {
					delete (layer.paint as Record<string, unknown>)['line-dasharray'];
				}
				layer.layout = {
					...(layer.layout ?? {}),
					visibility: 'visible',
					'line-cap': 'round',
					'line-join': 'round'
				};
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
