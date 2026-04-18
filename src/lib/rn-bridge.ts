// React Native WebView bridge.
// When the site is embedded in a RN WebView (?embed=1), we post events up to the
// host and listen for commands coming down. Outside of embed mode, this module is inert.

import { get } from 'svelte/store';

import type * as maplibregl from 'maplibre-gl';

import { changeOMfileURL } from '$lib/layers';
import { setGlobeProjection } from '$lib/map-controls';
import { LAYER_ID_DOT as SURFR_SPOTS_LAYER, setSurfrSpotsConfig } from '$lib/surfr-spots';

import { displayTimezone, displayTzOffsetSeconds } from '$lib/stores/preferences';
import { metaJson, time } from '$lib/stores/time';
import { domain, variable } from '$lib/stores/variables';

import { formatISOWithoutTimezone, ianaFromOffsetSeconds, parseISOWithoutTimezone } from './time-format';

// Every OutMsg gets stamped with `t` = ms since page load. Lets the RN host
// reconstruct an accurate timeline (gaps between events tell us where wall
// time goes — decode time, idle waits, render lag — that the per-event `ms`
// alone can't reveal).
type OutMsg =
	| { type: 'ready'; t: number }
	| { type: 'moveend'; lat: number; lng: number; zoom: number; t: number }
	| { type: 'availableTimestamps'; timestamps: string[]; t: number }
	| { type: 'availableVariables'; variables: string[]; t: number }
	| { type: 'timestampChanged'; time: string; t: number }
	| { type: 'forecastLocationSet'; lat: number; lng: number; t: number }
	| { type: 'spotClick'; id: string | number; name: string; lat: number; lng: number; t: number }
	| { type: 'referenceTime'; domain: string; referenceTime: string; t: number }
	| { type: 'tileFetch'; url: string; status: number; ms: number; bytes: number; cache: string; range: string; upMs: number; t: number }
	| { type: 'storageEstimate'; quotaMb: number; usageMb: number; cacheCount?: number; t: number }
	// New: lifecycle events to attribute time-loss
	| { type: 'setTimeReceived'; time: string; t: number }
	| { type: 'setVariableReceived'; variable: string; t: number }
	| { type: 'setDomainReceived'; domain: string; t: number }
	| { type: 'clearStateReceived'; t: number }
	| { type: 'mapDataLoading'; t: number }
	| { type: 'mapIdle'; t: number };

type InMsg =
	| { type: 'setCenter'; lat: number; lng: number; zoom?: number }
	| { type: 'setForecastLocation'; lat: number; lng: number }
	| { type: 'setVariable'; variable: string }
	| { type: 'setDomain'; domain: string }
	| { type: 'setTime'; time: string }
	| { type: 'setTzOffsetSeconds'; offsetSeconds: number }
	| { type: 'setSpotsConfig'; endpoint?: string; token?: string }
	// Zoom / projection control for the RN app's "world" icon. `setZoom`
	// flies to the target zoom (level 0 = fully zoomed out). Optionally
	// takes lat/lng to recenter. If `projection` is not set, we implicitly
	// flip to globe when zooming out below ~2 and to mercator above ~3 —
	// matches the RN UX where the "world" button feels like a globe view.
	| {
			type: 'setZoom';
			zoom: number;
			lat?: number;
			lng?: number;
			projection?: 'globe' | 'mercator';
	  }
	// Escape hatch for the RN host: wipe persisted state + Cache Storage and
	// reload the WebView. Used when the map gets stuck (e.g. a stale persisted
	// domain causing repeated metadata fetch failures) and no in-WebView
	// interaction un-sticks it.
	| { type: 'clearState' };

declare global {
	interface Window {
		ReactNativeWebView?: { postMessage: (s: string) => void };
	}
}

// Loose typing on purpose — TS struggles with the OutMsg discriminated union
// when stamping `t` after the fact. The OutMsg type above documents the wire
// shape; runtime code just spreads + adds `t`.
const postToRN = (msg: { type: string } & Record<string, unknown>): void => {
	const t = Math.round(performance.now());
	const stamped = { ...msg, t };
	const rn = typeof window !== 'undefined' ? window.ReactNativeWebView : undefined;
	if (rn?.postMessage) {
		try {
			rn.postMessage(JSON.stringify(stamped));
		} catch {
			/* noop */
		}
	}
	// Mirror to browser console so the same diagnostics show up when testing
	// the embed directly in a browser tab (no RN host present). Compact format
	// so the console doesn't get unreadable.
	if (typeof console !== 'undefined') {
		const { type, ...rest } = stamped;
		const restStr = Object.keys(rest).length
			? ' ' +
				Object.entries(rest)
					.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
					.join(' ')
			: '';
		console.log(`[bridge] ${type}${restStr}`);
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

	// Render-lifecycle markers. `dataloading` fires when MapLibre starts
	// requesting a source's tiles; `idle` fires when all in-flight requests
	// finished AND the canvas is repainted. The gap between the last setTime
	// and the next `idle` is the user-perceived "scrub-to-paint" wall time.
	let lastDataLoadingAt = 0;
	const onDataLoading = () => {
		const now = performance.now();
		if (now - lastDataLoadingAt > 50) postToRN({ type: 'mapDataLoading' });
		lastDataLoadingAt = now;
	};
	map.on('dataloading', onDataLoading);
	const onIdle = () => postToRN({ type: 'mapIdle' });
	map.on('idle', onIdle);

	// A tap anywhere on the map sets a forecast location — RN listens and refreshes
	// its model picker + ForecastTable for that point. Mirrors Windy's
	// "click to place forecast marker" UX.
	//
	// Exception: if the tap lands on (or near) a Surfr spot dot, emit `spotClick`
	// instead and skip the forecast-marker move — RN opens its SpotDetailSheet
	// for that spot and the user's intent clearly wasn't to relocate the forecast
	// pin.
	//
	// Hit-target padding: the visible dot is only `circle-radius: 4` (~8px wide),
	// way under Apple's 44pt / Material 48dp tap-target guidelines. Rather than
	// grow the dot, we expand the `queryRenderedFeatures` box to ±16px around the
	// tap — effective ~32px tap area with no visual change. Multiple hits in the
	// box: topmost (last-drawn) wins, which is what MapLibre returns first.
	const SPOT_HIT_PADDING_PX = 16;
	const onClick = (ev: maplibregl.MapMouseEvent) => {
		const { x, y } = ev.point;
		const bbox: [maplibregl.PointLike, maplibregl.PointLike] = [
			[x - SPOT_HIT_PADDING_PX, y - SPOT_HIT_PADDING_PX],
			[x + SPOT_HIT_PADDING_PX, y + SPOT_HIT_PADDING_PX]
		];
		const spotHit = map
			.queryRenderedFeatures(bbox, { layers: [SURFR_SPOTS_LAYER] })
			.find((f) => f.properties?.id != null);
		if (spotHit) {
			const [lng, lat] = (spotHit.geometry as GeoJSON.Point).coordinates;
			postToRN({
				type: 'spotClick',
				id: spotHit.properties!.id as string | number,
				name: (spotHit.properties!.name as string) ?? '',
				lat,
				lng
			});
			return;
		}
		const { lat, lng } = ev.lngLat;
		postToRN({ type: 'forecastLocationSet', lat, lng });
		placeForecastMarker(map, lat, lng);
	};
	map.on('click', onClick);

	// Desktop affordance: pointer cursor when hovering a spot dot. Harmless on
	// touch (no hover) but makes the embed feel right when used in a browser.
	const onSpotEnter = () => {
		map.getCanvas().style.cursor = 'pointer';
	};
	const onSpotLeave = () => {
		map.getCanvas().style.cursor = '';
	};
	map.on('mouseenter', SURFR_SPOTS_LAYER, onSpotEnter);
	map.on('mouseleave', SURFR_SPOTS_LAYER, onSpotLeave);

	const unsubMeta = metaJson.subscribe((meta) => {
		if (meta?.valid_times?.length) {
			postToRN({ type: 'availableTimestamps', timestamps: meta.valid_times });
		}
		// Expose the per-model variable manifest so RN can disable unsupported
		// overlay pills (rain / gusts on models that don't carry them).
		const variables = (meta as { variables?: string[] } | undefined)?.variables;
		if (Array.isArray(variables) && variables.length) {
			postToRN({ type: 'availableVariables', variables });
		}
		// Expose reference_time so the RN host can log what run it's rendering.
		// Handy for diagnosing cache-miss complaints.
		const refTime = (meta as { reference_time?: string } | undefined)?.reference_time;
		if (refTime) {
			postToRN({ type: 'referenceTime', domain: get(domain), referenceTime: refTime });
		}
	});

	// Monkey-patch window.fetch so every tile fetch (URL containing /tiles/ or
	// /data_spatial/) gets reported back to RN with status + timing + bytes.
	// This reveals exactly which .om URLs the library actually requests —
	// including the reference_time segment — and whether it's hitting the CF
	// edge or eating a cold upstream fetch.
	const origFetch = window.fetch.bind(window);
	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
				? input.toString()
				: (input as Request).url;
		const isTile = /\/(tiles|data_spatial)\//.test(url);
		if (!isTile) return origFetch(input, init);
		// Capture the Range header (if any) to detect duplicate block fetches —
		// if the BrowserBlockCache is silently failing or the WebView is
		// evicting Cache API entries, we'll see the same URL+range fetched
		// repeatedly within a session.
		let rangeHdr = '';
		try {
			const headers = init?.headers;
			if (headers instanceof Headers) rangeHdr = headers.get('Range') || '';
			else if (Array.isArray(headers)) {
				const h = headers.find(([k]) => k.toLowerCase() === 'range');
				if (h) rangeHdr = h[1] || '';
			} else if (headers && typeof headers === 'object') {
				rangeHdr = (headers as Record<string, string>).Range || (headers as Record<string, string>).range || '';
			}
		} catch {
			/* noop */
		}
		const start = performance.now();
		try {
			const res = await origFetch(input, init);
			const ms = Math.round(performance.now() - start);
			const bytes = Number(res.headers.get('content-length')) || 0;
			const cache = res.headers.get('x-surfr-cache-status') || '';
			const upMs = Number(res.headers.get('x-surfr-upstream-ms')) || 0;
			postToRN({
				type: 'tileFetch',
				url,
				status: res.status,
				ms,
				bytes,
				cache,
				range: rangeHdr,
				upMs
			});
			return res;
		} catch (err) {
			const ms = Math.round(performance.now() - start);
			postToRN({
				type: 'tileFetch',
				url,
				status: 0,
				ms,
				bytes: 0,
				cache: 'ERR',
				range: rangeHdr
			});
			throw err;
		}
	};

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
				postToRN({ type: 'setVariableReceived', variable: msg.variable });
				if (get(variable) !== msg.variable) variable.set(msg.variable);
				break;
			case 'setDomain':
				postToRN({ type: 'setDomainReceived', domain: msg.domain });
				if (get(domain) !== msg.domain) domain.set(msg.domain);
				break;
			case 'setTime': {
				postToRN({ type: 'setTimeReceived', time: msg.time });
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
			case 'setForecastLocation': {
				// Drop the red marker without moving the camera — used when the
				// RN host picks a search result / spot.
				placeForecastMarker(map, msg.lat, msg.lng);
				break;
			}
			case 'setTzOffsetSeconds': {
				// Display-only — no tile refetch. Timeline labels will re-render
				// reactively via Svelte store subscription.
				if (Number.isFinite(msg.offsetSeconds)) {
					displayTzOffsetSeconds.set(msg.offsetSeconds);
					// Pin displayTimezone to a matching IANA zone so any downstream
					// subscriber that recomputes offset-from-tz (e.g. TimezoneSelector's
					// time.subscribe → DST recompute) produces the same offset rather
					// than pegging back to the viewer's browser timezone.
					displayTimezone.set(ianaFromOffsetSeconds(msg.offsetSeconds));
				}
				break;
			}
			case 'setSpotsConfig': {
				setSurfrSpotsConfig({ endpoint: msg.endpoint, token: msg.token });
				break;
			}
			case 'setZoom': {
				const center = map.getCenter();
				// Projection flip — explicit via msg.projection, or implicit when
				// zooming out below 2 (feels right: world icon = globe view).
				const targetProjection =
					msg.projection ??
					(msg.zoom <= 2 ? 'globe' : msg.zoom > 3 ? 'mercator' : undefined);
				if (targetProjection) {
					setGlobeProjection(targetProjection === 'globe');
				}
				map.flyTo({
					center: [msg.lng ?? center.lng, msg.lat ?? center.lat],
					zoom: msg.zoom,
					essential: true
				});
				break;
			}
			case 'clearState': {
				// Ack first so the RN side can dismiss its spinner even if the
				// reload wins the race.
				postToRN({ type: 'clearStateReceived' });
				void (async () => {
					try {
						const keys = await caches.keys();
						await Promise.all(keys.map((k) => caches.delete(k)));
					} catch (err) {
						console.warn('[rn-bridge] clearState: caches.delete failed', err);
					}
					try {
						localStorage.clear();
					} catch (err) {
						console.warn('[rn-bridge] clearState: localStorage.clear failed', err);
					}
					window.location.reload();
				})();
				break;
			}
		}
	};
	window.addEventListener('message', onWindowMessage);
	// On Android, messages come through document too.
	document.addEventListener('message', onWindowMessage as EventListener);

	postToRN({ type: 'ready' });

	// One-shot storage probe so we can see what the WebView's Cache API actually
	// allows. If `usageMb` plateaus far below `cacheMaxBytesMb` (default 400) it
	// means the platform is silently quota-evicting and the library's local
	// block cache isn't actually holding what it thinks it is.
	const probeStorage = async () => {
		try {
			const est = (await (navigator as unknown as { storage?: { estimate: () => Promise<{ quota?: number; usage?: number }> } }).storage?.estimate?.()) ?? null;
			if (!est) return;
			let cacheCount: number | undefined;
			try {
				const keys = await caches.keys();
				cacheCount = keys.length;
			} catch {
				/* noop */
			}
			postToRN({
				type: 'storageEstimate',
				quotaMb: Math.round((est.quota ?? 0) / 1e6),
				usageMb: Math.round((est.usage ?? 0) / 1e6),
				cacheCount
			});
		} catch {
			/* noop */
		}
	};
	probeStorage();
	// Also probe periodically so we can watch usage grow and see if it plateaus.
	const storageProbeInterval = setInterval(probeStorage, 30 * 1000);

	return () => {
		map.off('moveend', onMoveEnd);
		map.off('click', onClick);
		map.off('mouseenter', SURFR_SPOTS_LAYER, onSpotEnter);
		map.off('mouseleave', SURFR_SPOTS_LAYER, onSpotLeave);
		map.off('dataloading', onDataLoading);
		map.off('idle', onIdle);
		unsubMeta();
		unsubTime();
		clearInterval(storageProbeInterval);
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
