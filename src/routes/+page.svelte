<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { get } from 'svelte/store';

	import {
		type Domain,
		GridFactory,
		domainOptions,
		omProtocol,
		updateCurrentBounds
	} from '@openmeteo/weather-map-layer';
	import * as maplibregl from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { toast } from 'svelte-sonner';

	import { version } from '$app/environment';

	import { map } from '$lib/stores/map';
	import { omProtocolSettings } from '$lib/stores/om-protocol-settings';
	import {
		loading,
		displayTimezone,
		displayTzOffsetSeconds,
		localStorageVersion,
		opacity,
		resetStates,
		tileSize,
		tileSizeSet,
		url
	} from '$lib/stores/preferences';
	import { metaJson, modelRun, time } from '$lib/stores/time';
	import { domain, selectedDomain, selectedVariable, variable } from '$lib/stores/variables';

	import KeyboardHandler from '$lib/components/keyboard/keyboard-handler.svelte';
	import Spinner from '$lib/components/loading/spinner.svelte';
	import ModelPills from '$lib/components/overlay-pills/model-pills.svelte';
	import OverlayPills from '$lib/components/overlay-pills/overlay-pills.svelte';
	import PopWarmToast from '$lib/components/pop-warm-toast.svelte';
	import RunDateLabel from '$lib/components/run-date-label.svelte';
	import Settings from '$lib/components/settings/settings.svelte';
	import TimeSelector from '$lib/components/time/time-selector.svelte';
	import TimezoneSelector from '$lib/components/timezone/TimezoneSelector.svelte';

	import { setMode } from 'mode-watcher';

	import { checkHighDefinition } from '$lib/helpers';
	import { initSurfrSpots, setSurfrSpotsConfig } from '$lib/surfr-spots';
	import { getIanaOffsetSeconds, ianaFromOffsetSeconds } from '$lib/time-format';
	import { addOmFileLayers, changeOMfileURL } from '$lib/layers';
	import { installRnBridge, isEmbedMode } from '$lib/rn-bridge';
	import { addTerrainSource, getStyle, setMapControlSettings } from '$lib/map-controls';
	import { getInitialMetaData, getMetaData, matchVariableOrFirst } from '$lib/metadata';
	import { warmCurrentPoP } from '$lib/pop-warm';
	import { addPopup } from '$lib/popup';
	import { formatISOWithoutTimezone } from '$lib/time-format';
	import { findTimeStep } from '$lib/time-utils';
	import { updateUrl, urlParamsToPreferences } from '$lib/url';

	import '../styles.css';

	import type { RequestParameters } from 'maplibre-gl';

	let mapContainer: HTMLElement | null;

	let embed = $state(false);
	let rnBridgeCleanup: (() => void) | undefined;

	onMount(async () => {
		$url = new URL(document.location.href);
		embed = isEmbedMode();
		// Tag the body so CSS can tweak layout in embed mode (e.g. move the
		// MapLibre GlobeControl out of the RN app's top-right overlap zone
		// for debugging).
		if (embed) document.body.classList.add('embed');

		// Optional ?clearCache=1 wipes the BrowserBlockCache before the library
		// initialises so we can A/B test cold-start performance from a known
		// baseline. Used during diagnostics — RN passes this on every embed
		// load to make every test cold (apples-to-apples comparison).
		if ($url.searchParams.get('clearCache') === '1') {
			try {
				const keys = await caches.keys();
				for (const k of keys) await caches.delete(k);
				console.log('[fork] cleared', keys.length, 'cache(s):', keys);
			} catch (err) {
				console.warn('[fork] clearCache failed:', err);
			}
		}

		// Optional ?theme=dark|light|system override. Used by the RN WebView
		// so the embed matches the host app's theme regardless of the iOS
		// simulator's / Android device's system appearance.
		const themeParam = $url.searchParams.get('theme');
		if (themeParam === 'dark' || themeParam === 'light' || themeParam === 'system') {
			setMode(themeParam);
		}

		// Optional ?opacity=N override (0-100). Used to debug the
		// embed-vs-browser brightness divergence.
		const opacityParam = $url.searchParams.get('opacity');
		if (opacityParam) {
			const n = Number(opacityParam);
			if (Number.isFinite(n)) opacity.set(Math.max(0, Math.min(100, n)));
		}

		// Optional ?tz_offset_seconds=N — RN override for the display timezone
		// (passes the spot's utc_offset_seconds). When absent, standalone web
		// falls back to the user's chosen displayTimezone from localStorage.
		const tzParam = $url.searchParams.get('tz_offset_seconds');
		if (tzParam) {
			const n = Number(tzParam);
			if (Number.isFinite(n)) {
				displayTzOffsetSeconds.set(n);
				// Pin displayTimezone too. Otherwise TimezoneSelector's time-change
				// subscription recomputes the offset from the persisted IANA name
				// (usually the viewer's browser tz) and clobbers our value the moment
				// the user advances the time cursor.
				displayTimezone.set(ianaFromOffsetSeconds(n));
			}
		} else {
			// Compute from the persisted IANA name, DST-aware for "now".
			displayTzOffsetSeconds.set(getIanaOffsetSeconds(get(displayTimezone)));
		}

		// Optional Surfr spots layer config — RN supplies backend URL + auth
		// token via URL params (and can refresh via bridge). Unset → no spots.
		const spotsEndpoint = $url.searchParams.get('spots_endpoint');
		const spotsToken = $url.searchParams.get('spots_token');
		if (spotsEndpoint && spotsToken) {
			setSurfrSpotsConfig({ endpoint: spotsEndpoint, token: spotsToken });
		}

		urlParamsToPreferences();

		// first time on load, check if monitor supports high definition, for increased tile size
		if (!get(tileSizeSet)) {
			if (checkHighDefinition()) {
				tileSize.set(1024);
			}
			tileSizeSet.set(true);
		}

		// resets all the states when a new version is set in 'package.json' and version already set before
		if (version !== $localStorageVersion) {
			if ($localStorageVersion) {
				await resetStates();
			}
			$localStorageVersion = version;
		}

		// Boot-time audit of the color-scale wiring. Surfaces any divergence
		// between the scales we *think* we registered and what maplibre actually
		// sees at request time.
		{
			const settings = $omProtocolSettings;
			const scales = settings.colorScales as Record<string, { colors?: unknown[] }>;
			const windScale = scales['wind'];
			const uScale = scales['wind_u_component_10m'];
			console.log('[surfr-boot]', {
				hasResolveRequest: typeof settings.resolveRequest === 'function',
				windKeys: Object.keys(scales).filter((k) => k.startsWith('wind')),
				windFirstColor: windScale?.colors?.[0],
				windUCompFirstColor: uScale?.colors?.[0],
				currentVariable: get(variable),
				currentDomain: get(domain),
				persistedCustomColorScales: (() => {
					try {
						return Object.keys(JSON.parse(localStorage.getItem('custom-color-scales') ?? '{}'));
					} catch {
						return '<parse error>';
					}
				})()
			});
		}

		maplibregl.addProtocol('om', (params: RequestParameters, abortController: AbortController) => {
			// Per-request trace. `params.url` is the om:// URL that includes the
			// active variable; if this doesn't contain `wind` when you expect it
			// to, the problem is upstream in the variable store.
			console.log('[surfr-protocol]', { url: params.url });
			const result = omProtocol(params, abortController, $omProtocolSettings);
			result.then(
				(res: unknown) => console.log('[surfr-protocol] resolved', { url: params.url, res }),
				(err: unknown) => console.error('[surfr-protocol] REJECTED', { url: params.url, err })
			);
			return result;
		});

		const style = await getStyle();

		const domainObject = domainOptions.find(({ value }: Domain) => value === $domain);
		if (!domainObject) {
			throw new Error('Domain not found');
		}
		const grid = GridFactory.create(domainObject.grid);

		$map = new maplibregl.Map({
			container: mapContainer as HTMLElement,
			style: style,
			center: grid.getCenter(),
			zoom: domainObject.grid.zoom,
			keyboard: false,
			hash: true,
			maxPitch: 85,
			// Hide MapLibre's default "© OpenMapTiles / © OpenStreetMap" strip when
			// embedded — the RN app shows its own attribution in settings/about.
			attributionControl: embed ? false : undefined
		});

		setMapControlSettings({ embed });

		// update bounds when new tiles are requested, to trigger new data ranges loading if necessary
		$map.on('dataloading', () => {
			const bounds = $map.getBounds();
			const [minLng, minLat] = bounds.getSouthWest().toArray();
			const [maxLng, maxLat] = bounds.getNorthEast().toArray();
			updateCurrentBounds([minLng, minLat, maxLng, maxLat]);
		});

		$map.on('load', async () => {
			// All the upstream chrome (DarkMode/Settings/Help/Clipping/Hillshade
			// buttons + clipping panel) was removed when we simplified the
			// standalone UI to just OverlayPills + TimeSelector. Keep the load
			// flow itself.
			if (getInitialMetaDataPromise) await getInitialMetaDataPromise;

			addTerrainSource($map);
			addTerrainSource($map, 'terrainSource2');

			addOmFileLayers();
			// Skip the click-to-show m/s popup in embed — RN owns the forecast UI.
			if (!embed) addPopup();
			changeOMfileURL();

			initSurfrSpots($map);

			rnBridgeCleanup = installRnBridge($map);
		});
	});

	let getInitialMetaDataPromise: Promise<void> | undefined;

	// Serialize domain-load work. Without this, Svelte fires the subscription
	// multiple times during startup (initial value + `urlParamsToPreferences`
	// override + RN bridge `setDomain` after 'ready'), and the async callbacks
	// run in parallel — mutating shared stores (`latest`, `mR`,
	// `$metaJson`) out of order. That produces a stuck state where
	// `mR.set(latestReferenceTime)` lands with `latestReferenceTime=undefined`
	// because the other callback hasn't populated `latest` yet, so modelRun
	// becomes `undefined as Date`, `fetchMetaData` builds `.../undefined/meta.json`,
	// 404, throw, stuck. Roughly 50% of cold starts per user report.
	let domainLoadChain: Promise<void> = Promise.resolve();
	let latestDomainReq = 0;

	const runDomainLoad = async (newDomain: string, reqId: number): Promise<void> => {
		if ($domain !== newDomain) {
			await tick(); // await the selectedDomain to be set
			if (reqId !== latestDomainReq) return; // superseded while awaiting tick
			updateUrl('domain', newDomain);
			$modelRun = undefined;
			toast('Domain set to: ' + $selectedDomain.label);
		}

		// Retry with exponential backoff (500ms, 1s, 2s). Handles transient
		// edge 5xx during a model-run publish, flaky mobile networks, cold
		// R2 misses. With the serialization above, retries no longer race
		// with a competing in-flight callback; each retry is clean.
		const maxAttempts = 3;
		let lastErr: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			if (reqId !== latestDomainReq) return; // superseded between attempts
			try {
				getInitialMetaDataPromise = (async () => {
					await getInitialMetaData();
					if (reqId !== latestDomainReq) return; // superseded mid-fetch
					$metaJson = await getMetaData();
					if (reqId !== latestDomainReq) return;

					const timeSteps = $metaJson?.valid_times.map(
						(validTime: string) => new Date(validTime)
					);
					const timeStep = findTimeStep($time, timeSteps);
					// clamp time to valid times in meta data
					if (timeStep) {
						$time = timeStep;
						updateUrl('time', formatISOWithoutTimezone($time));
					} else {
						// otherwise use first valid time
						$time = timeSteps[0];
						updateUrl('time', formatISOWithoutTimezone($time));
					}

					matchVariableOrFirst();
				})();
				await getInitialMetaDataPromise;
				lastErr = undefined;
				break;
			} catch (err) {
				lastErr = err;
				console.warn(
					`[domain-subscription] metadata fetch failed (attempt ${attempt}/${maxAttempts})`,
					err
				);
				if (attempt < maxAttempts) {
					await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
				}
			}
		}

		if (reqId !== latestDomainReq) return; // superseded after retries

		if (lastErr !== undefined) {
			// All retries exhausted. We don't restore a previous modelRun
			// because the server (Pages Function → R2) is the source of truth
			// for the active run — our .om URL deliberately omits the run path
			// (see url.ts:getOMUrl). Next domain/variable/time interaction
			// will retrigger the subscription and retry.
			toast.error('Could not load map data — please try again');
			console.error('[domain-subscription] gave up after retries', lastErr);
			return;
		}

		changeOMfileURL();
		// Fire the per-PoP cache warm for this domain's 72 h of .om URLs.
		// Fire-and-forget: the warm runs in the background while the first
		// scrub renders from R2, and subsequent scrubs hit the now-warm edge.
		void warmCurrentPoP(newDomain);
	};

	const domainSubscription = domain.subscribe((newDomain) => {
		const reqId = ++latestDomainReq;
		// Chain onto the previous load so runs are strictly serial. `.catch`
		// swallows prior errors so one failure doesn't break the chain.
		domainLoadChain = domainLoadChain
			.catch(() => {})
			.then(() => runDomainLoad(newDomain, reqId));
	});

	const variableSubscription = variable.subscribe(async (newVar) => {
		if ($variable !== newVar) {
			await tick(); // await the selectedVariable to be set
			updateUrl('variable', newVar);
			toast('Variable set to: ' + $selectedVariable.label);
		}

		changeOMfileURL();
	});

	onDestroy(() => {
		rnBridgeCleanup?.();
		if ($map) {
			$map.remove();
		}
		domainSubscription(); // unsubscribe
		variableSubscription(); // unsubscribe
	});
</script>

<svelte:head>
	<title>Open-Meteo Maps</title>
</svelte:head>

{#if $loading}
	<Spinner />
{/if}

<div class="map maplibregl-map" id="#map_container" bind:this={mapContainer}></div>

{#if !embed}
	<!-- Simplified standalone UI: only what's needed to navigate.
	     - Wind/Gust/Rain pill selector (top-left)
	     - Time scrubber (bottom)
	     - Keyboard shortcuts for the time selector
	     Everything else (clipping, scale, settings, help, dropzone, full
	     VariableSelection) was removed to match the focused RN app UX. -->
	<OverlayPills />
	<ModelPills />
	<div class="tz-wrapper">
		<TimezoneSelector />
	</div>
	<TimeSelector />
	<KeyboardHandler />
	<Settings />
{/if}

<!-- Also rendered in embed so the RN WebView shows the cache-warm progress
     toast on domain switch — useful debugging feedback for the user. -->
<PopWarmToast />

<!-- Small label showing the current run date. Always rendered (embed + web)
     so mobile users can see which run their tiles came from. Same 120px top
     as the pop-warm toast — toast overlays it while warming, which is fine. -->
<RunDateLabel />

<style>
	/* Stacked in the top-left column under ModelPills + OverlayPills. */
	.tz-wrapper {
		position: absolute;
		top: 100px;
		left: 12px;
		z-index: 5;
	}
</style>

