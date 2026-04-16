<script lang="ts">
	import { fly } from 'svelte/transition';

	import { popWarmProgress } from '$lib/pop-warm';

	// Show while warming in progress, or briefly after done so the user sees
	// the completion count. Hide otherwise.
	let visible = $state(false);
	let hideTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const s = $popWarmProgress.status;
		if (s === 'running') {
			if (hideTimer) {
				clearTimeout(hideTimer);
				hideTimer = null;
			}
			visible = true;
		} else if (s === 'done' || s === 'failed') {
			visible = true;
			if (hideTimer) clearTimeout(hideTimer);
			hideTimer = setTimeout(() => {
				visible = false;
				hideTimer = null;
			}, 2000);
		} else {
			visible = false;
		}
	});

	const pct = $derived(
		$popWarmProgress.total > 0
			? Math.round(($popWarmProgress.done / $popWarmProgress.total) * 100)
			: 0
	);
</script>

{#if visible}
	<div class="warm-toast" transition:fly={{ y: -20, duration: 220 }}>
		<div class="label">
			{#if $popWarmProgress.status === 'running'}
				Warming {$popWarmProgress.domain} cache…
				<span class="count">{$popWarmProgress.done}/{$popWarmProgress.total}</span>
			{:else if $popWarmProgress.status === 'done'}
				Cache warm {$popWarmProgress.ok}/{$popWarmProgress.total}
				{#if $popWarmProgress.fail > 0}
					<span class="warn">({$popWarmProgress.fail} failed)</span>
				{/if}
			{:else if $popWarmProgress.status === 'failed'}
				Cache warm failed
			{/if}
		</div>
		{#if $popWarmProgress.status === 'running'}
			<div class="track">
				<div class="fill" style="width: {pct}%"></div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.warm-toast {
		position: fixed;
		/* Pushed below iPhone status bar + RN app's top chrome (search bar
		   etc). The standalone web UI has no top chrome, but 120px is still
		   a comfortable reading zone under the native MapLibre controls. */
		top: 120px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 100;
		background: rgba(20, 20, 28, 0.85);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 10px;
		padding: 8px 14px;
		color: #fff;
		font: 500 12px/1.2 system-ui, -apple-system, sans-serif;
		min-width: 240px;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
	}
	.label {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.count {
		margin-left: auto;
		color: rgba(255, 255, 255, 0.7);
		font-variant-numeric: tabular-nums;
	}
	.warn {
		color: rgb(251, 191, 36);
		margin-left: 4px;
	}
	.track {
		margin-top: 6px;
		height: 3px;
		background: rgba(255, 255, 255, 0.15);
		border-radius: 2px;
		overflow: hidden;
	}
	.fill {
		height: 100%;
		background: rgb(74, 222, 128);
		transition: width 120ms ease-out;
	}
</style>
