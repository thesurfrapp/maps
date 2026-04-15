// React Native WebView bridge.
// When the site is embedded in a RN WebView (?embed=1), we post events up to the
// host and listen for commands coming down. Outside of embed mode, this module is inert.

import { get } from 'svelte/store';

import type * as maplibregl from 'maplibre-gl';

import { metaJson, time } from '$lib/stores/time';
import { domain, variable } from '$lib/stores/variables';

import { formatISOWithoutTimezone, parseISOWithoutTimezone } from './time-format';

type OutMsg =
	| { type: 'ready' }
	| { type: 'moveend'; lat: number; lng: number; zoom: number }
	| { type: 'availableTimestamps'; timestamps: string[] }
	| { type: 'timestampChanged'; time: string };

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
			return;
		}
		if (!msg || typeof msg !== 'object') return;
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
				const parsed =
					msg.time.length === 15 ? parseISOWithoutTimezone(msg.time) : new Date(msg.time);
				if (!isNaN(parsed.getTime())) time.set(parsed);
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
		unsubMeta();
		unsubTime();
		window.removeEventListener('message', onWindowMessage);
		document.removeEventListener('message', onWindowMessage as EventListener);
	};
};
