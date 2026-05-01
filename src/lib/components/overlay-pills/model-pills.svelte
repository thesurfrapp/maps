<!--
  ModelPicker — model dropdown for the standalone-browser UI.

  Shows ONLY the tile domains the Surfr RN app exposes (see
  /Users/herbert/Documents/GitHub/frontend/components/src/screens/Spots/openMeteoMapConfig.js).
  Standalone parity with the app — no extra/exotic Open-Meteo models.
-->
<script lang="ts">
	import { domain, variable } from '$lib/stores/variables';

	// User-facing "logical" model. A single entry in the dropdown per weather
	// model — GFS is ONE row here even though it actually fans out across two
	// sibling tile domains (`ncep_gfs013` for wind/rain, `ncep_gfs025` for
	// gusts). The RN app does the same routing; see
	// /frontend/components/src/screens/Spots/openMeteoMapConfig.js.
	// Order: highest resolution → coarsest.
	const MODELS: { value: string; label: string }[] = [
		{ value: 'metno_nordic_pp', label: 'MET Nordic 1km' },
		{ value: 'meteofrance_arome_france_hd', label: 'Arome-HD 1.3km' },
		{ value: 'dwd_icon_d2', label: 'ICON-D2 2km' },
		{ value: 'knmi_harmonie_arome_netherlands', label: 'KNMI NL 2km' },
		{ value: 'ukmo_uk_deterministic_2km', label: 'UKV 2km' },
		{ value: 'meteofrance_arome_france0025', label: 'Arome 2.5km' },
		{ value: 'cmc_gem_hrdps', label: 'GEM HRDPS 2.5km' },
		{ value: 'ncep_hrrr_conus', label: 'HRRR 3km' },
		{ value: 'knmi_harmonie_arome_europe', label: 'HARMONIE 5.5km' },
		{ value: 'ecmwf_ifs025', label: 'ECMWF 9km' },
		{ value: 'dwd_icon', label: 'ICON 11km' },
		{ value: 'gfs', label: 'GFS 13km' }
	];

	// Map a logical model + current variable to the actual tile domain.
	// Wind/rain live in ncep_gfs013, gusts in ncep_gfs025.
	const resolveTileDomain = (logical: string, currentVariable: string): string => {
		if (logical === 'gfs') {
			return currentVariable === 'wind_gusts_10m' ? 'ncep_gfs025' : 'ncep_gfs013';
		}
		return logical;
	};

	// Reverse map: the persisted `$domain` store is a real tile domain; collapse
	// the GFS pair back into 'gfs' so the dropdown shows one selected row.
	const collapseToLogical = (tileDomain: string): string => {
		if (tileDomain === 'ncep_gfs013' || tileDomain === 'ncep_gfs025') return 'gfs';
		return tileDomain;
	};

	$: selectedLogical = collapseToLogical($domain);

	// Keep the tile domain in sync with the active overlay (gust vs wind/rain).
	// When the user flips Gusts ↔ Wind while on GFS we route to the sibling
	// domain automatically, matching the RN app's per-overlay routing.
	$: {
		const target = resolveTileDomain(selectedLogical, $variable);
		if (target !== $domain) domain.set(target);
	}

	const onChange = (e: Event) => {
		const logical = (e.target as HTMLSelectElement).value;
		const target = resolveTileDomain(logical, $variable);
		if (target !== $domain) domain.set(target);
	};
</script>

<div class="wrapper">
	<select class="model-select" on:change={onChange} value={selectedLogical}>
		{#each MODELS as model}
			<option value={model.value}>{model.label}</option>
		{/each}
	</select>
</div>

<style>
	.wrapper {
		position: absolute;
		top: 12px;
		left: 12px; /* top-left; OverlayPills sits below this */
		z-index: 5;
	}
	.model-select {
		appearance: none;
		-webkit-appearance: none;
		background: rgba(20, 20, 28, 0.7);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 8px;
		padding: 8px 32px 8px 12px;
		color: #fff;
		font: 600 12px/1 system-ui, -apple-system, sans-serif;
		cursor: pointer;
		min-width: 180px;
		background-image:
			linear-gradient(45deg, transparent 50%, rgba(255, 255, 255, 0.6) 50%),
			linear-gradient(135deg, rgba(255, 255, 255, 0.6) 50%, transparent 50%);
		background-position:
			right 14px top 50%,
			right 9px top 50%;
		background-size:
			5px 5px,
			5px 5px;
		background-repeat: no-repeat;
	}
	.model-select:focus {
		outline: 1px solid rgba(74, 222, 128, 0.5);
		outline-offset: 1px;
	}
	.model-select option {
		background: #14141c;
		color: #fff;
	}
</style>
