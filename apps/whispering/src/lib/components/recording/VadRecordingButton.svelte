<script lang="ts">
	import { commandCallbacks } from '$lib/commands';
	import { vadStateToIcons, type VadState } from '$lib/constants/audio';
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import type { CreateQueryResult } from '@tanstack/svelte-query';
	import { cn } from '@repo/ui/utils';

	interface Props {
		getVadStateQuery: CreateQueryResult<VadState, Error>;
		unstyled?: boolean;
		showLabel?: boolean;
	}

	let {
		getVadStateQuery,
		unstyled = false,
		showLabel = false,
	}: Props = $props();

	const state = $derived(getVadStateQuery.data ?? 'IDLE');
	const icon = $derived(vadStateToIcons[state]);

	const labelText = $derived(
		state === 'IDLE'
			? 'Start voice activated session'
			: 'Stop voice activated session',
	);
</script>

{#if unstyled}
	<!-- Sidebar mode: unstyled button with sidebar classes -->
	<button
		type="button"
		onclick={commandCallbacks.toggleVadRecording}
		class="peer/menu-button outline-hidden ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm transition-[width,height,padding] focus-visible:ring-2 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0"
		title={labelText}
	>
		<div class="relative shrink-0">
			<span class="text-base flex items-center justify-center size-4"
				>{icon}</span
			>
		</div>
		{#if showLabel}
			<span>{labelText}</span>
		{/if}
	</button>
{:else}
	<!-- Standard mode: WhisperingButton with tooltip -->
	<WhisperingButton
		tooltipContent={labelText}
		onclick={commandCallbacks.toggleVadRecording}
		variant="ghost"
		size="icon"
	>
		{icon}
	</WhisperingButton>
{/if}
