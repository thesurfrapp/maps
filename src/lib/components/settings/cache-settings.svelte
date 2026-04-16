<script lang="ts">
	import { untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { slide } from 'svelte/transition';

	import { clearBlockCache } from '@openmeteo/weather-map-layer';

	import { cacheBlockSizeKb, cacheMaxBytesMb } from '$lib/stores/om-protocol-settings';
	import { domain } from '$lib/stores/variables';

	import { popWarmProgress, warmCurrentPoP } from '$lib/pop-warm';

	import Button from '$lib/components/ui/button/button.svelte';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';

	const triggerManualWarm = () => warmCurrentPoP(get(domain));

	const blockSizeOptions = [
		{ value: '16', label: '16 KiB' },
		{ value: '32', label: '32 KiB' },
		{ value: '64', label: '64 KiB' },
		{ value: '128', label: '128 KiB' },
		{ value: '256', label: '256 KiB' },
		{ value: '512', label: '512 KiB' }
	];

	const appliedBlockSize = get(cacheBlockSizeKb);
	const appliedMaxBytes = get(cacheMaxBytesMb);

	const reload = () => window.location.reload();

	let initialized = false;

	$effect(() => {
		const _blockSize = $cacheBlockSizeKb;
		const _maxBytes = $cacheMaxBytesMb;
		untrack(() => {
			if (initialized) {
				clearBlockCache();
			}
			initialized = true;
		});
	});
</script>

<div>
	<h2 class="text-lg font-bold">Cache</h2>
	<div class="mt-3 flex flex-col gap-3">
		<div class="flex items-center gap-3">
			<Label class="w-28 shrink-0">Block Size</Label>
			<Select.Root
				type="single"
				value={String($cacheBlockSizeKb)}
				onValueChange={(v) => {
					if (v) $cacheBlockSizeKb = Number(v);
				}}
			>
				<Select.Trigger class="w-24 bg-background/60" aria-label="Select cache block size">
					{blockSizeOptions.find((o) => o.value === String($cacheBlockSizeKb))?.label ??
						`${$cacheBlockSizeKb} KiB`}
				</Select.Trigger>
				<Select.Content class="z-110 border-none bg-glass/65 backdrop-blur-sm min-w-25">
					{#each blockSizeOptions as option (option.value)}
						<Select.Item value={option.value}>{option.label}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		<div class="flex items-center gap-3">
			<Label for="cache-max-bytes" class="w-28 shrink-0">Max Cache (MB)</Label>
			<Input
				id="cache-max-bytes"
				type="number"
				min={1}
				class="w-24 bg-background/60"
				bind:value={$cacheMaxBytesMb}
			/>
		</div>
		{#if $cacheBlockSizeKb !== appliedBlockSize || $cacheMaxBytesMb !== appliedMaxBytes}
			<div transition:slide>
				<Button class="cursor-pointer self-start" onclick={reload}>Reload to apply</Button>
			</div>
		{/if}
		<div class="mt-2 flex flex-col gap-1">
			<Label class="text-xs text-muted-foreground">
				Warm this PoP for the current domain (fires 1-byte range requests so CF
				pre-caches the next 72 h of .om files at your local edge). Also runs
				automatically on model switch.
			</Label>
			<Button
				class="cursor-pointer self-start"
				disabled={$popWarmProgress.status === 'running'}
				onclick={triggerManualWarm}
			>
				{#if $popWarmProgress.status === 'idle'}
					Warm this PoP (72 h)
				{:else if $popWarmProgress.status === 'running'}
					Warming… {$popWarmProgress.done}/{$popWarmProgress.total}
				{:else if $popWarmProgress.status === 'done'}
					Warmed {$popWarmProgress.ok}/{$popWarmProgress.total} (click to re-run)
				{:else}
					Warm failed — retry
				{/if}
			</Button>
			{#if $popWarmProgress.status === 'done' && $popWarmProgress.fail > 0}
				<span class="text-xs text-amber-500">{$popWarmProgress.fail} requests failed</span>
			{/if}
		</div>
	</div>
</div>
