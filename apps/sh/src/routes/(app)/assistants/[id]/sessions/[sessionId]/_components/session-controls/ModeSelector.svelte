<script lang="ts">
	import type { AssistantConfig } from '$lib/stores/assistant-configs.svelte';

	import * as rpc from '$lib/query';
	import { Skeleton } from '@repo/ui/skeleton';
	import * as ToggleGroup from '@repo/ui/toggle-group';
	import { createQuery } from '@tanstack/svelte-query';
	import { Code, Lightbulb, MessageSquare } from '@lucide/svelte';

	let {
		assistantConfig,
		class: className,
		onModeChange,
		value = $bindable(),
	}: {
		assistantConfig: AssistantConfig;
		class?: string;
		onModeChange?: (mode: string) => void;
		value?: string;
	} = $props();

	// Create query for modes
	const modesQuery = createQuery(
		rpc.modes.getModes(() => assistantConfig).options,
	);

	const modes = $derived(modesQuery.data ?? []);

	// Get icon for mode
	function getModeIcon(modeName: string) {
		switch (modeName) {
			case 'build':
				return Code;
			case 'plan':
				return Lightbulb;
			default:
				return MessageSquare;
		}
	}
</script>

{#if modesQuery.isPending}
	<Skeleton class="h-9 w-[200px]" />
{:else if modesQuery.isError}
	<div class="text-sm text-destructive">Failed to load modes</div>
{:else}
	<ToggleGroup.Root
		type="single"
		bind:value={
			() => value,
			(newValue) => {
				if (newValue) {
					value = newValue;
					onModeChange?.(newValue);
				}
			}
		}
		class={className}
	>
		{#each modes as mode (mode.name)}
			{@const Icon = getModeIcon(mode.name)}
			<ToggleGroup.Item value={mode.name} aria-label="{mode.name} mode">
				<Icon class="size-4 mr-2" />
				{mode.name}
			</ToggleGroup.Item>
		{/each}
	</ToggleGroup.Root>
{/if}
