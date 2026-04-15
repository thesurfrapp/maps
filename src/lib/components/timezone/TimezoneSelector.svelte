<script lang="ts">
	import { get } from 'svelte/store';

	import { displayTimezone, displayTzOffsetSeconds } from '$lib/stores/preferences';
	import { time } from '$lib/stores/time';

	import { getIanaOffsetSeconds } from '$lib/time-format';

	const formatOffsetLabel = (seconds: number): string => {
		const sign = seconds >= 0 ? '+' : '-';
		const total = Math.abs(seconds);
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		return `UTC${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
	};

	// All IANA zones the browser supports. Intl.supportedValuesOf is universal
	// on the browsers we target (iOS 17+, Chrome 96+). Each option is labelled
	// with the current UTC offset so users see e.g. "UTC+02:00 · Europe/Amsterdam"
	// without needing a separate offset badge in the UI.
	const zones: { value: string; label: string }[] = (() => {
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const anyIntl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
			const list = anyIntl.supportedValuesOf ? anyIntl.supportedValuesOf('timeZone') : [];
			const unique = Array.from(new Set(['UTC', ...list])).sort();
			return unique.map((z) => ({
				value: z,
				label: `${formatOffsetLabel(getIanaOffsetSeconds(z))} · ${z}`
			}));
		} catch {
			return [{ value: 'UTC', label: 'UTC+00:00 · UTC' }];
		}
	})();

	// Recompute the offset the timeline uses when the zone or the selected
	// forecast time changes (the latter matters across DST boundaries).
	const recomputeOffset = () => {
		displayTzOffsetSeconds.set(getIanaOffsetSeconds(get(displayTimezone), get(time)));
	};
	displayTimezone.subscribe(recomputeOffset);
	time.subscribe(recomputeOffset);
</script>

<select
	class="tz-select"
	bind:value={$displayTimezone}
	title="Display timezone"
>
	{#each zones as z (z.value)}
		<option value={z.value}>{z.label}</option>
	{/each}
</select>

<style>
	/* Matches model-pills dropdown styling so both controls read as siblings. */
	.tz-select {
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
	.tz-select:focus {
		outline: 1px solid rgba(74, 222, 128, 0.5);
		outline-offset: 1px;
	}
	.tz-select option {
		background: #14141c;
		color: #fff;
	}
</style>
