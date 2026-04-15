// React Native WebView bridge.
// When the site is embedded in a RN WebView (?embed=1), we post events up to the
// host and listen for commands coming down. Outside of embed mode, this module is inert.

import { get } from 'svelte/store';

import type * as maplibregl from 'maplibre-gl';

import { changeOMfileURL } from '$lib/layers';

import { metaJson, time } from '$lib/stores/time';
import { domain, variable } from '$lib/stores/variables';

import { formatISOWithoutTimezone, parseISOWithoutTimezone } from './time-format';

type OutMsg =
	| { type: 'ready' }
	| { type: 'moveend'; lat: number; lng: number; zoom: number }
	| { type: 'availableTimestamps'; timestamps: string[] }
	| { type: 'timestampChanged'; time: string }
	| { type: 'forecastLocationSet'; lat: number; lng: number };

type InMsg =
	| { type: 'setCenter'; lat: number; lng: number; zoom?: number }
	| { type: 'setVariable'; variable: string }
	| { type: 'setDomain'; domain: string }
	| { type: 'setTime'; time: string };

declare global {
	interface Window {
		ReactNativeWebView?: { postMessage: (s: string) => void };
	}
}

const postToRN = (msg: OutMsg): void => {
	const rn = typeof window !== 'undefined' ? window.ReactNativeWebView : undefined;
	if (!rn?.postMessage) return;
	try {
		rn.postMessage(JSON.stringify(msg));
	} catch {
		/* noop */
	}
};

export const isEmbedMode = (): boolean => {
	if (typeof window === 'undefined') return false;
	return new URLSearchParams(window.location.search).get('embed') === '1';
};

// postMessage floods on every moveend / time change are fine, but we debounce moveend
// so mid-pan frames don't spam the RN thread.
const debounce = <T extends unknown[]>(fn: (...args: T) => void, ms: number) => {
	let t: ReturnType<typeof setTimeout> | undefined;
	return (...args: T) => {
		if (t) clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	};
};

export const installRnBridge = (map: maplibregl.Map): (() => void) => {
	if (!isEmbedMode()) return () => {};

	const onMoveEnd = debounce(() => {
		const c = map.getCenter();
		postToRN({ type: 'moveend', lat: c.lat, lng: c.lng, zoom: map.getZoom() });
	}, 150);
	map.on('moveend', onMoveEnd);

	// A tap anywhere on the map sets a forecast location — RN listens and refreshes
	// its model picker + ForecastTable for that point. Mirrors Windy's
	// "click to place forecast marker" UX.
	const onClick = (ev: maplibregl.MapMouseEvent) => {
		const { lat, lng } = ev.lngLat;
		postToRN({ type: 'forecastLocationSet', lat, lng });
		placeForecastMarker(map, lat, lng);
	};
	map.on('click', onClick);

	const unsubMeta = metaJson.subscribe((meta) => {
		if (meta?.valid_times?.length) {
			postToRN({ type: 'availableTimestamps', timestamps: meta.valid_times });
		}
	});

	const unsubTime = time.subscribe((t) => {
		if (t) postToRN({ type: 'timestampChanged', time: formatISOWithoutTimezone(t) });
	});

	const onWindowMessage = (ev: MessageEvent): void => {
		let msg: InMsg | undefined;
		try {
			msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : (ev.data as InMsg);
		} catch {
			console.warn('[rn-bridge] non-JSON message', ev.data);
			return;
		}
		if (!msg || typeof msg !== 'object') return;
		console.log('[rn-bridge] ←', msg);
		switch (msg.type) {
			case 'setCenter':
				map.flyTo({
					center: [msg.lng, msg.lat],
					zoom: msg.zoom ?? map.getZoom(),
					essential: true
				});
				break;
			case 'setVariable':
				if (get(variable) !== msg.variable) variable.set(msg.variable);
				break;
			case 'setDomain':
				if (get(domain) !== msg.domain) domain.set(msg.domain);
				break;
			case 'setTime': {
				// Mirror what the fork's own time-selector does: set the store
				// AND call changeOMfileURL() — only domain + variable have their
				// own subscriptions that re-fetch tiles; time doesn't.
				const parsed =
					msg.time.length === 15 ? parseISOWithoutTimezone(msg.time) : new Date(msg.time);
				if (!isNaN(parsed.getTime())) {
					time.set(parsed);
					changeOMfileURL();
				}
				break;
			}
		}
	};
	window.addEventListener('message', onWindowMessage);
	// On Android, messages come through document too.
	document.addEventListener('message', onWindowMessage as EventListener);

	postToRN({ type: 'ready' });

	return () => {
		map.off('moveend', onMoveEnd);
		map.off('click', onClick);
		unsubMeta();
		unsubTime();
		window.removeEventListener('message', onWindowMessage);
		document.removeEventListener('message', onWindowMessage as EventListener);
	};
};

// Persistent forecast marker — one red target icon, moved on each tap.
const MARKER_SOURCE_ID = 'rn-forecast-marker';
const MARKER_LAYER_ID = 'rn-forecast-marker-layer';
const placeForecastMarker = (map: maplibregl.Map, lat: number, lng: number): void => {
	const data = {
		type: 'FeatureCollection' as const,
		features: [
			{ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [lng, lat] }, properties: {} }
		]
	};
	const src = map.getSource(MARKER_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
	if (src) {
		src.setData(data as GeoJSON.FeatureCollection);
		return;
	}
	map.addSource(MARKER_SOURCE_ID, { type: 'geojson', data: data as GeoJSON.FeatureCollection });
	map.addLayer({
		id: MARKER_LAYER_ID,
		type: 'circle',
		source: MARKER_SOURCE_ID,
		paint: {
			'circle-radius': 8,
			'circle-color': '#ef4444',
			'circle-stroke-color': '#ffffff',
			'circle-stroke-width': 2
		}
	});
};
