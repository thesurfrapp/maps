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

// Single in-flight prefetch — aborted every time the user triggers a new read.
// Prevents the old stalling behaviour where a slow prefetch held up HTTP/2
// streams behind the user's next click.
let currentPrefetchController: AbortController | null = null;


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
		const v = resolved.dataOptions.variable;
		const matched = WIND_VARIABLE_PATTERN.test(v);
		// Print once per URL so the console isn't drowned by per-tile calls.
		const sig = `${urlComponents.baseUrl}?variable=${v}`;
		if (sig !== (window as unknown as { __lastOmSig?: string }).__lastOmSig) {
			(window as unknown as { __lastOmSig?: string }).__lastOmSig = sig;
			const incomingColors = JSON.stringify(
				(resolved.renderOptions.colorScale as { colors?: unknown }).colors
			).slice(0, 60);
			const surfrColors = surfrWindScale.colors as unknown as unknown[];
			const surfrFirstColor = JSON.stringify(surfrColors[0]);
			console.log('[surfr-colors]', {
				variable: v,
				matched,
				incomingScaleUnit: (resolved.renderOptions.colorScale as { unit?: string }).unit,
				incomingFirstColors: incomingColors,
				surfrFirstColor,
				colorScalesRegistered: Object.keys(settings.colorScales).filter((k) =>
					k.startsWith('wind')
				)
			});
		}
		if (matched) {
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
		// Prefetch the prev/next-hour .om files so the next scrub click feels
		// instant. We abort any in-flight prefetch before starting a new one —
		// that was the bit missing previously (the footer fetch used to linger
		// on the HTTP/2 connection, blocking the user's next click for ~10 s).
		// With the `_iterateDataBlocks` parallel patch in `om-reader-patch.ts`
		// the initial index-block reads now land in ~1 s instead of N×RTT, so
		// lingering prefetch is small even on slow networks.
		if (currentPrefetchController) {
			currentPrefetchController.abort();
		}
		currentPrefetchController = new AbortController();
		const signal = currentPrefetchController.signal;
		const nextOmUrls = getNextOmUrls(state.omFileUrl, get(selectedDomain), get(metaJson));
		for (const nextOmUrl of nextOmUrls) {
			if (nextOmUrl === undefined) continue;
			// setToOmFile reads the .om header; swallow errors so one bad URL
			// doesn't kill the other direction's prefetch.
			void (async () => {
				try {
					await omFileReader.setToOmFile(nextOmUrl);
					if (signal.aborted) return;
					// 'not_a_real_variable' makes the library issue only the header
					// probe + ~65 KB footer read — no data-block fetches. Restores
					// the pre-revert behaviour that warms just enough of the next-
					// hour file so a subsequent scrub starts with hot index state.
					await omFileReader.prefetchVariable('not_a_real_variable', null, signal);
				} catch (err) {
					if ((err as { name?: string } | undefined)?.name === 'AbortError') return;
					console.debug('[prefetch] skipped', nextOmUrl, err);
				}
			})();
		}
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
