<script lang="ts">
	import { get } from 'svelte/store';

	import { displayTimezone, displayTzOffsetSeconds } from '$lib/stores/preferences';
	import { time } from '$lib/stores/time';

	import { getIanaOffsetSeconds } from '$lib/time-format';

	// All IANA zones the browser supports. Intl.supportedValuesOf is universal on
	// the browsers we target (iOS 17+, Chrome 96+).
	const zones: string[] = (() => {
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const anyIntl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
			const list = anyIntl.supportedValuesOf ? anyIntl.supportedValuesOf('timeZone') : [];
			return Array.from(new Set(['UTC', ...list])).sort();
		} catch {
			return ['UTC'];
		}
	})();

	// Recompute the offset the timeline uses when the zone or the selected
	// forecast time changes (the latter matters across DST boundaries).
	const recomputeOffset = () => {
		displayTzOffsetSeconds.set(getIanaOffsetSeconds(get(displayTimezone), get(time)));
	};
	displayTimezone.subscribe(recomputeOffset);
	time.subscribe(recomputeOffset);

	const formatOffsetLabel = (seconds: number): string => {
		const sign = seconds >= 0 ? '+' : '-';
		const total = Math.abs(seconds);
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		return `UTC${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
	};
</script>

<div class="flex items-center gap-1.5">
	<!-- Mirrors the domain/variable dropdown styling so it sits as a sibling
	     control in the top-left stack. -->
	<div
		class="bg-glass/75 dark:bg-glass/75 backdrop-blur-sm shadow-md hover:bg-glass/95 h-7.25 w-45 rounded flex items-center"
	>
		<select
			bind:value={$displayTimezone}
			class="bg-transparent text-foreground text-sm flex-1 px-1.5 py-0.5 cursor-pointer outline-none appearance-none truncate"
			title="Display timezone"
		>
			{#each zones as z (z)}
				<option value={z}>{z}</option>
			{/each}
		</select>
	</div>
	<span class="text-[0.7rem] opacity-70 tabular-nums whitespace-nowrap">
		{formatOffsetLabel($displayTzOffsetSeconds)}
	</span>
</div>
