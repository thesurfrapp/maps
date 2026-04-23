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

	// In embed mode the RN app owns all UI — don't render any MapLibre
	// default controls or our own SettingsButton/GlobeControl. RN handles
	// zoom/globe via postMessage (setZoom / setGlobeProjection bridge).
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

	// GlobeControl — MapLibre's built-in projection toggle. Its own click
	// handler flips projection; we add `globeHandler()` after it to persist
	// the preference to localStorage + URL. Added after Navigation + Geo so
	// it lines up below them in the top-right stack.
	const globeControl = new maplibregl.GlobeControl();
	map.addControl(globeControl);
	globeControl._globeButton.addEventListener('click', () => globeHandler());

	// Settings sheet trigger — standalone web UI only.
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
	const isDark = mode.current === 'dark';

	// Primary basemap: MapTiler Streets v2. Gives the "Google-Maps-like"
	// look (proper road hierarchy, landuse tints, POIs). Key is passed via
	// a Vite env var so it isn't committed — add `VITE_MAPTILER_KEY=xxx`
	// to a local `.env` (or the hosting env) and rebuild. If the key is
	// absent we fall back to OpenFreeMap's minimalist dark/positron so dev
	// still works without the key.
	const maptilerKey = import.meta.env.VITE_MAPTILER_KEY as string | undefined;
	const useMaptiler = Boolean(maptilerKey);

	let styleUrl: string;
	if (useMaptiler) {
		const mtStyle = isDark ? 'streets-v2-dark' : 'voyager-v2';
		styleUrl = `https://api.maptiler.com/maps/${mtStyle}/style.json?key=${encodeURIComponent(maptilerKey!)}`;
	} else {
		const styleName = isDark ? 'dark' : 'positron';
		styleUrl = `https://tiles.openfreemap.org/styles/${styleName}`;
	}
	const style = await fetch(styleUrl).then((r) => r.json());

	// OpenFreeMap gets the aggressive strip-down (building/landuse/etc.
	// hidden, country borders forced white, coastline added) to make the
	// weather raster dominate. MapTiler is left mostly intact — the whole
	// point of switching is to keep its Google-Maps-like detail. We only
	// force English labels on top so dual-script places don't cram.
	if (Array.isArray(style.layers) && !useMaptiler) {
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
			// (text-field English override is applied globally further down.)
			if (src === 'place' && layer.type === 'symbol') {
				layer.paint = {
					...(layer.paint ?? {}),
					'text-color': '#ffffff',
					'text-halo-color': 'rgba(0,0,0,0)',
					'text-halo-width': 0,
					'text-halo-blur': 0
				};
			}
		}

		// Coastline is now added in the universal post-block so both
		// OpenFreeMap and MapTiler get it.
	}

	// English-only label override — runs for BOTH basemaps. Without this,
	// MapTiler streets still ships dual-script labels (e.g. English + Arabic
	// stacked vertically) which reads cluttered.
	if (Array.isArray(style.layers)) {
		for (const layer of style.layers) {
			const src: string = layer?.['source-layer'] ?? '';
			if (src !== 'place' || layer.type !== 'symbol') continue;
			layer.layout = {
				...(layer.layout ?? {}),
				'text-field': [
					'coalesce',
					['get', 'name:en'],
					['get', 'name_en'],
					['get', 'name:latin'],
					['get', 'name_int']
				]
			};
		}

		// White coastline — strokes ocean polygons so the land/sea edge reads
		// clearly against the weather raster. Basemap-agnostic: we find
		// whichever source exposes the `water` source-layer (OpenFreeMap:
		// `openmaptiles`, MapTiler: `maptiler_planet`) and draw from it.
		const waterHost = style.layers.find(
			(l: { type: string; 'source-layer'?: string; source?: string }) =>
				l['source-layer'] === 'water'
		);
		if (waterHost?.source && !style.layers.find((l: { id: string }) => l.id === 'surfr_coastline')) {
			const coastline = {
				id: 'surfr_coastline',
				type: 'line',
				source: waterHost.source,
				'source-layer': 'water',
				// Only ocean polygons — exclude rivers / lakes / ponds.
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
			const firstSymbolIdx = style.layers.findIndex((l: { type: string }) => l.type === 'symbol');
			if (firstSymbolIdx >= 0) {
				style.layers.splice(firstSymbolIdx, 0, coastline);
			} else {
				style.layers.push(coastline);
			}
		}

		// White country outline — useful at zoomed-out levels (continent /
		// country view) to separate landmasses from the weather raster.
		// Fades out as the user zooms into city level where borders are
		// less relevant and roads take over orientation. Custom overlay so
		// we don't have to fight the basemap's own boundary styling.
		const boundaryHost = style.layers.find(
			(l: { type: string; 'source-layer'?: string; source?: string }) =>
				l.type === 'line' && l['source-layer'] === 'boundary'
		);
		if (boundaryHost?.source && !style.layers.find((l: { id: string }) => l.id === 'surfr_country_border')) {
			const countryBorder = {
				id: 'surfr_country_border',
				type: 'line',
				source: boundaryHost.source,
				'source-layer': 'boundary',
				filter: [
					'all',
					['==', ['to-number', ['get', 'admin_level']], 2],
					['!=', ['to-number', ['get', 'maritime']], 1]
				],
				paint: {
					'line-color': '#ffffff',
					'line-opacity': [
						'interpolate',
						['linear'],
						['zoom'],
						0, 1,
						5, 1,
						8, 0.7,
						11, 0.3,
						14, 0
					],
					'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 4, 1.2, 8, 1.6]
				}
			};
			// Insert just before the first symbol layer so labels still sit
			// on top — otherwise the border would cut through city names.
			const firstSymbolIdx = style.layers.findIndex((l: { type: string }) => l.type === 'symbol');
			if (firstSymbolIdx >= 0) {
				style.layers.splice(firstSymbolIdx, 0, countryBorder);
			} else {
				style.layers.push(countryBorder);
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
