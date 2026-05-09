<!--
  OverlayPills — simplified standalone-browser overlay selector.

  Mirrors the RN app's WindMapControls pill UI: just three buttons (Wind /
  Gust / Rain). Each maps to one or more candidate variable names, and we
  pick the first that's actually present in the active model's manifest. If
  no candidate is present, the pill is rendered disabled.

  Replaces the upstream VariableSelection panel (which exposed every
  variable in the model) on the public-facing maps.thesurfr.app page.
-->
<script lang="ts">
	import { metaJson } from '$lib/stores/time';
	import { domain, variable } from '$lib/stores/variables';
	import { setWindyStationsConfig, setWindyStationsVisible } from '$lib/windy-stations';
	import { map } from '$lib/stores/map';

	type Overlay = 'wind' | 'gust' | 'rain';

	let stationsVisible = false;

	// Same priority order as the RN side. First match in the model's
	// `meta.variables` wins. Keep in sync with
	// /frontend/components/src/screens/Spots/openMeteoMapConfig.js.
	// Magnitude first, u-component as fallback. (u-component is signed; the
	// library derives sqrt(u²+v²) automatically when only u/v are published,
	// so this alias still renders as magnitude.)
	const OVERLAY_VARIABLE_ALIASES: Record<Overlay, string[]> = {
		wind: ['wind_speed_10m', 'wind_u_component_10m'],
		gust: ['wind_gusts_10m'],
		rain: ['rain', 'precipitation']
	};

	// Logical GFS — wind/rain live in ncep_gfs013, gusts in ncep_gfs025.
	// The two tile domains form one user-facing "GFS 13km" model; treating
	// them as a pair here means the Gusts pill stays enabled on GFS even when
	// the active manifest is ncep_gfs013 (which lacks wind_gusts_10m).
	// ModelPills flips the actual `$domain` when `$variable` changes.
	const GFS_PAIR = new Set(['ncep_gfs013', 'ncep_gfs025']);
	const GFS_OVERLAY_TO_VARIABLE: Record<Overlay, string> = {
		wind: 'wind_u_component_10m',
		gust: 'wind_gusts_10m',
		rain: 'precipitation'
	};

	const PILLS: { key: Overlay; label: string }[] = [
		{ key: 'wind', label: 'Wind' },
		{ key: 'gust', label: 'Gusts' },
		{ key: 'rain', label: 'Rain' }
	];

	const resolveVariable = (overlay: Overlay, available: string[]): string | null => {
		const aliases = OVERLAY_VARIABLE_ALIASES[overlay] || [];
		if (!available || available.length === 0) return aliases[0] ?? null;
		return aliases.find((v) => available.includes(v)) || null;
	};

	$: available = ($metaJson as { variables?: string[] } | undefined)?.variables ?? [];
	$: isGfs = GFS_PAIR.has($domain);

	$: resolvedForPill = (overlay: Overlay): string | null =>
		isGfs ? GFS_OVERLAY_TO_VARIABLE[overlay] : resolveVariable(overlay, available);

	$: activeOverlay = ((): Overlay | null => {
		for (const [key, aliases] of Object.entries(OVERLAY_VARIABLE_ALIASES) as [
			Overlay,
			string[]
		][]) {
			if (aliases.includes($variable)) return key;
		}
		return null;
	})();

	const onSelect = (key: Overlay) => {
		const v = resolvedForPill(key);
		if (v) variable.set(v);
	};

	const toggleStations = () => {
		stationsVisible = !stationsVisible;
		const m = $map;
		if (!m) return;
		const endpoint = new URLSearchParams(window.location.search).get('ws_endpoint')
			|| new URLSearchParams(window.location.search).get('spots_endpoint')
			|| '';
		if (endpoint && stationsVisible) {
			setWindyStationsConfig({ endpoint, visible: true });
		}
		setWindyStationsVisible(m, stationsVisible);
	};
</script>

<div class="pills">
	{#each PILLS as pill}
		{@const resolved = resolvedForPill(pill.key)}
		{@const disabled = !resolved}
		<button
			type="button"
			class="pill"
			class:active={activeOverlay === pill.key}
			class:disabled
			disabled={disabled}
			on:click={() => onSelect(pill.key)}
		>
			{pill.label}
		</button>
	{/each}
	<button
		type="button"
		class="pill"
		class:active={stationsVisible}
		on:click={toggleStations}
	>
		Live
	</button>
</div>

<style>
	.pills {
		position: absolute;
		/* Stacked under the model dropdown (top-left of the viewport). */
		top: 56px;
		left: 12px;
		display: flex;
		gap: 6px;
		z-index: 5;
		background: rgba(20, 20, 28, 0.7);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 8px;
		padding: 4px;
	}
	.pill {
		padding: 6px 12px;
		font: 600 12px/1 system-ui, -apple-system, sans-serif;
		color: rgba(255, 255, 255, 0.8);
		background: transparent;
		border: 0;
		border-radius: 5px;
		cursor: pointer;
		transition: background 120ms ease;
	}
	.pill:hover:not(.disabled):not(.active) {
		background: rgba(255, 255, 255, 0.08);
	}
	.pill.active {
		background: rgba(74, 222, 128, 0.18);
		color: #4ade80;
	}
	.pill.disabled {
		color: rgba(255, 255, 255, 0.25);
		cursor: not-allowed;
	}
</style>
