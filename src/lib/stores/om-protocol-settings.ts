import { type Writable, get, writable } from 'svelte/store';

import { BrowserBlockCache } from '@openmeteo/file-reader';
import {
	type WeatherMapLayerFileReader,
	defaultOmProtocolSettings,
	defaultResolveRequest,
	resolveColorScale
} from '@openmeteo/weather-map-layer';
import { persisted } from 'svelte-persisted-store';

import { browser } from '$app/environment';

import { surfrWindScale } from '$lib/color-scales/surfr';
import {
	DEFAULT_CACHE_BLOCK_SIZE_KB,
	DEFAULT_CACHE_MAX_BYTES_MB,
	HTTP_OVERHEAD_BYTES
} from '$lib/constants';
import { getNextOmUrls } from '$lib/url';

import { metaJson } from './time';
import { selectedDomain } from './variables';

import type {
	Data,
	OmProtocolSettings,
	OmUrlState,
	RenderableColorScale
} from '@openmeteo/weather-map-layer';

export const customColorScales = persisted<Record<string, RenderableColorScale>>(
	'custom-color-scales',
	{}
);

export const cacheBlockSizeKb = persisted('cache-block-size-kb', DEFAULT_CACHE_BLOCK_SIZE_KB);
export const cacheMaxBytesMb = persisted('cache-max-bytes-mb', DEFAULT_CACHE_MAX_BYTES_MB);

const initialCustomColorScales = get(customColorScales);

function createBlockCache() {
	if (!browser) return undefined;
	return new BrowserBlockCache({
		blockSize: get(cacheBlockSizeKb) * 1024 - HTTP_OVERHEAD_BYTES,
		cacheName: 'open-meteo-maps-cache-v1',
		memCacheTtlMs: 1000,
		maxBytes: get(cacheMaxBytesMb) * 1024 * 1024
	});
}

// Variable names that must render with the Surfr wind palette, not the
// Open-Meteo default. We used to rely on the library's colorScales map
// (exact-match lookup in `getOptionalColorScale`), but that kept getting
// bypassed somewhere in the chain — browser shows the default blue-green-red
// gradient for u/v component winds regardless of how we keyed the overrides.
// Forcing the scale here via a custom `resolveRequest` is the only
// unambiguous way to make it stick for every wind-family variable.
const WIND_VARIABLE_PATTERN = /^wind_(speed|gusts|u_component|v_component)(_|$)/;

export const omProtocolSettings: Writable<OmProtocolSettings> = writable({
	...defaultOmProtocolSettings,
	// static
	fileReaderConfig: {
		useSAB: true,
		cache: createBlockCache()
	},

	// dynamic (can be changed during runtime).
	// Order matters: persisted user customs are applied FIRST, then Surfr's
	// scale is layered on top.
	colorScales: {
		...defaultOmProtocolSettings.colorScales,
		...initialCustomColorScales,
		wind: surfrWindScale,
		wind_speed_10m: surfrWindScale,
		wind_gusts_10m: surfrWindScale,
		wind_u_component_10m: surfrWindScale,
		wind_v_component_10m: surfrWindScale
	},

	// Hard override. Wrap the library's default resolver and patch the
	// colorScale for any wind-family variable to surfrWindScale. Belt-and-
	// braces on top of the colorScales map above.
	resolveRequest: (urlComponents, settings) => {
		const resolved = defaultResolveRequest(urlComponents, settings);
		if (WIND_VARIABLE_PATTERN.test(resolved.dataOptions.variable)) {
			const dark = urlComponents.params.get('dark') === 'true';
			resolved.renderOptions = {
				...resolved.renderOptions,
				colorScale: resolveColorScale(surfrWindScale, dark),
				intervals: surfrWindScale.breakpoints
			};
		}
		return resolved;
	},

	postReadCallback: (omFileReader: WeatherMapLayerFileReader, data: Data, state: OmUrlState) => {
		// PREFETCH DISABLED — the upstream behaviour was to fetch the
		// prev/next-hour file index after each load (a `200 1KB` probe + a
		// `206 ~65KB` end-of-file footer read). On a real network the footer
		// fetch consistently took 7-8 s and remained in-flight on the same
		// HTTP/2 connection. When the user clicked the next hour while it
		// was still pending, their new range reads queued behind it,
		// producing the visible ~10 s "second click is slow" effect.
		// Trade-off: we lose the next-click "feels instant" benefit on
		// slow scrubbing in exchange for predictable per-click latency on
		// fast scrubbing. Re-enable + add AbortController if we want both.
		// const nextOmUrls = getNextOmUrls(state.omFileUrl, get(selectedDomain), get(metaJson));
		// for (const nextOmUrl of nextOmUrls) {
		// 	if (nextOmUrl === undefined) continue;
		// 	omFileReader.setToOmFile(nextOmUrl);
		// 	omFileReader.prefetchVariable('not_a_real_variable');
		// }
		if (
			state.dataOptions.domain.value === 'ecmwf_ifs' &&
			state.dataOptions.variable === 'pressure_msl'
		) {
			if (data.values) {
				data.values = data.values?.map((value) => value / 100);
			}
		}
	}
});
