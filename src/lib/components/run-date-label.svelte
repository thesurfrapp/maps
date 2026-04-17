<script lang="ts">
	import { modelRun, time } from '$lib/stores/time';
	import { displayTzOffsetSeconds } from '$lib/stores/preferences';

	const formatted = $derived.by(() => {
		const d = $modelRun;
		if (!d) return null;
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
	});

	// Debug: the embed's currently-selected time, rendered in the embed's own display tz so
	// we can sanity-check alignment against the RN host's bottom-sheet header.
	const currentFormatted = $derived.by(() => {
		const d = $time;
		if (!d) return null;
		const offsetSec = $displayTzOffsetSeconds || 0;
		const shifted = new Date(d.getTime() + offsetSec * 1000);
		const pad = (n: number) => String(n).padStart(2, '0');
		const sign = offsetSec >= 0 ? '+' : '-';
		const abs = Math.abs(offsetSec);
		const tzH = pad(Math.floor(abs / 3600));
		const tzM = pad(Math.floor((abs % 3600) / 60));
		return (
			`${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
			`${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())} GMT${sign}${tzH}:${tzM}`
		);
	});
</script>

{#if formatted}
	<div class="run-label">
		<div>Run {formatted}</div>
		{#if currentFormatted}
			<div class="current-label">{currentFormatted}</div>
		{/if}
	</div>
{/if}

<style>
	.run-label {
		position: fixed;
		top: 120px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 100;
		background: rgba(20, 20, 28, 0.65);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 8px;
		padding: 3px 8px;
		color: rgba(255, 255, 255, 0.9);
		font: 500 10px/1.2 system-ui, -apple-system, sans-serif;
		pointer-events: none;
		letter-spacing: 0.02em;
		text-align: center;
	}
	.current-label {
		margin-top: 2px;
		color: rgba(255, 255, 255, 0.65);
		font-weight: 400;
		font-size: 9px;
	}
</style>
