<script lang="ts">
	import { modelRun } from '$lib/stores/time';

	const formatted = $derived.by(() => {
		const d = $modelRun;
		if (!d) return null;
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
	});
</script>

{#if formatted}
	<div class="run-label">Run {formatted}</div>
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
	}
</style>
