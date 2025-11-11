<script lang="ts">
	import { commandCallbacks } from '$lib/commands';
	import { recorderStateToIcons } from '$lib/constants/audio';
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import type { CreateQueryResult } from '@tanstack/svelte-query';
	import type { WhisperingRecordingState } from '$lib/constants/audio/recording-states';
	import { cn } from '@repo/ui/utils';

	interface Props {
		getRecorderStateQuery: CreateQueryResult<WhisperingRecordingState, Error>;
		unstyled?: boolean;
		showLabel?: boolean;
	}

	let {
		getRecorderStateQuery,
		unstyled = false,
		showLabel = false,
	}: Props = $props();

	const state = $derived(getRecorderStateQuery.data ?? 'IDLE');
	const icon = $derived(recorderStateToIcons[state]);

	const labelText = $derived(
		state === 'IDLE' ? 'Start manual recording' : 'Stop manual recording',
	);
</script>

{#if unstyled}
	<!-- Sidebar mode: unstyled button with sidebar classes -->
	<button
		type="button"
		onclick={commandCallbacks.toggleManualRecording}
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
		onclick={commandCallbacks.toggleManualRecording}
		variant="ghost"
		size="icon"
	>
		{icon}
	</WhisperingButton>
{/if}
