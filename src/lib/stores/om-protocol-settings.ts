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

import { surfrWindScale, surfrWindScaleEmbed } from '$lib/color-scales/surfr';
import { isEmbedMode } from '$lib/rn-bridge';

// Pick the active wind scale once at module-load time. Embed mode gets an
// alpha=1 (effectively alpha-less) variant with darkened low-knot hues +
// whitened high-knot hues — the mobile WebView drops per-pixel alpha from
// the tile texture, so "calm fades to dark, strong pops bright" has to live
// entirely in the RGB channel.
const activeWindScale = isEmbedMode() ? surfrWindScaleEmbed : surfrWindScale;
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
		wind: activeWindScale,
		wind_speed_10m: activeWindScale,
		wind_gusts_10m: activeWindScale,
		wind_u_component_10m: activeWindScale,
		wind_v_component_10m: activeWindScale
	},

	// Hard override. Wrap the library's default resolver and patch the
	// colorScale for any wind-family variable to activeWindScale. Belt-and-
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
			const surfrColors = activeWindScale.colors as unknown as unknown[];
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
				colorScale: resolveColorScale(activeWindScale, dark),
				intervals: activeWindScale.breakpoints
			};
		}
		return resolved;
	},

	postReadCallback: (omFileReader: WeatherMapLayerFileReader, data: Data, state: OmUrlState) => {
		// PER-HOUR PREFETCH DISABLED — replaced by a whole-domain PoP warm that
		// runs once on model switch (see `src/lib/pop-warm.ts`, triggered from
		// `src/routes/+page.svelte`'s domain.subscribe). That warm fires 1-byte
		// range requests for all validTimes in the next 72 h, letting CF's
		// cache-on-range pull each full file into local-PoP edge cache. After
		// it finishes, scrubbing anywhere in that window is an instant local-
		// edge HIT, making the per-scrub prefetch redundant.
		//
		// Left as reference — original per-hour prefetch code. Uncomment if we
		// ever want to go back to lazy prev/next-hour warming instead of the
		// upfront whole-domain approach.
		//
		// if (currentPrefetchController) {
		// 	currentPrefetchController.abort();
		// }
		// currentPrefetchController = new AbortController();
		// const signal = currentPrefetchController.signal;
		// const nextOmUrls = getNextOmUrls(state.omFileUrl, get(selectedDomain), get(metaJson));
		// for (const nextOmUrl of nextOmUrls) {
		// 	if (nextOmUrl === undefined) continue;
		// 	void (async () => {
		// 		try {
		// 			await omFileReader.setToOmFile(nextOmUrl);
		// 			if (signal.aborted) return;
		// 			await omFileReader.prefetchVariable('not_a_real_variable', null, signal);
		// 		} catch (err) {
		// 			if ((err as { name?: string } | undefined)?.name === 'AbortError') return;
		// 			console.debug('[prefetch] skipped', nextOmUrl, err);
		// 		}
		// 	})();
		// }
		void omFileReader;
		void state;
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
