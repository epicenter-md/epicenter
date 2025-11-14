<script lang="ts">
	import { getContext } from 'svelte';
	import { commandCallbacks } from '$lib/commands';
	import NavItems from '$lib/components/NavItems.svelte';
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import {
		RecordingModeSelector,
		CompressionSelector,
		TranscriptionSelector,
		TransformationSelector,
	} from '$lib/components/settings';
	import ManualDeviceSelector from '$lib/components/settings/selectors/ManualDeviceSelector.svelte';
	import VadDeviceSelector from '$lib/components/settings/selectors/VadDeviceSelector.svelte';
	import { recorderStateToIcons, vadStateToIcons } from '$lib/constants/audio';
	import { rpc } from '$lib/query';
	import { settings } from '$lib/stores/settings.svelte';
	import { cn } from '@repo/ui/utils';
	import { createQuery } from '@tanstack/svelte-query';
	import { MediaQuery } from 'svelte/reactivity';

	const getRecorderStateQuery = createQuery(
		rpc.recorder.getRecorderState.options,
	);
	const getVadStateQuery = createQuery(rpc.vadRecorder.getVadState.options);

	let { children } = $props();

	// Get migrationDialog from context (only available in Tauri)
	const migrationDialog = window.__TAURI_INTERNALS__
		? getContext<{
				hasIndexedDBData: boolean;
				openDialog: () => void;
			}>('migrationDialog')
		: undefined;

	const isMobile = new MediaQuery('(max-width: 640px)');
</script>

<header
	class={cn(
		'border-border/40 bg-background/95 supports-backdrop-filter:bg-background/60 sticky top-0 z-50 border-b shadow-xs backdrop-blur-sm ',
		'flex h-14 w-full items-center justify-between px-4 sm:px-8',
	)}
	style="view-transition-name: header"
>
	<WhisperingButton
		tooltipContent="Go home"
		href="/"
		variant="ghost"
		class="-ml-4"
	>
		<span class="text-lg font-bold">whispering</span>
	</WhisperingButton>

	<div class="flex items-center gap-1.5">
		<div class="flex items-center gap-1.5">
			{#if settings.value['recording.mode'] === 'manual'}
				{#if getRecorderStateQuery.data === 'RECORDING'}
					<WhisperingButton
						tooltipContent="Cancel recording"
						onclick={commandCallbacks.cancelManualRecording}
						variant="ghost"
						size="icon"
						style="view-transition-name: cancel-icon;"
					>
						🚫
					</WhisperingButton>
				{:else}
					<ManualDeviceSelector />
					<CompressionSelector />
					<TranscriptionSelector />
					<TransformationSelector />
				{/if}
				{#if getRecorderStateQuery.data === 'RECORDING'}
					<WhisperingButton
						tooltipContent="Stop recording"
						onclick={commandCallbacks.toggleManualRecording}
						variant="ghost"
						size="icon"
						style="view-transition-name: microphone-icon"
					>
						{recorderStateToIcons[getRecorderStateQuery.data ?? 'IDLE']}
					</WhisperingButton>
				{:else}
					<div class="flex">
						<WhisperingButton
							tooltipContent="Start recording"
							onclick={commandCallbacks.toggleManualRecording}
							variant="ghost"
							size="icon"
							style="view-transition-name: microphone-icon"
							class="rounded-r-none border-r-0"
						>
							{recorderStateToIcons[getRecorderStateQuery.data ?? 'IDLE']}
						</WhisperingButton>
						<RecordingModeSelector class="rounded-l-none" />
					</div>
				{/if}
			{:else if settings.value['recording.mode'] === 'vad'}
				{#if getVadStateQuery.data === 'IDLE'}
					<VadDeviceSelector />
					<CompressionSelector />
					<TranscriptionSelector />
					<TransformationSelector />
				{/if}
				{#if getVadStateQuery.data === 'IDLE'}
					<div class="flex">
						<WhisperingButton
							tooltipContent="Start voice activated recording"
							onclick={commandCallbacks.toggleVadRecording}
							variant="ghost"
							size="icon"
							style="view-transition-name: microphone-icon"
							class="rounded-r-none border-r-0"
						>
							{vadStateToIcons[getVadStateQuery.data ?? 'IDLE']}
						</WhisperingButton>
						<RecordingModeSelector class="rounded-l-none" />
					</div>
				{:else}
					<WhisperingButton
						tooltipContent="Stop voice activated recording"
						onclick={commandCallbacks.toggleVadRecording}
						variant="ghost"
						size="icon"
						style="view-transition-name: microphone-icon"
					>
						{vadStateToIcons[getVadStateQuery.data ?? 'IDLE']}
					</WhisperingButton>
				{/if}
			{:else if settings.value['recording.mode'] === 'upload'}
				<CompressionSelector />
				<TranscriptionSelector />
				<TransformationSelector />
				<RecordingModeSelector />
			{:else if settings.value['recording.mode'] === 'live'}
				<ManualDeviceSelector />
				<CompressionSelector />
				<TranscriptionSelector />
				<TransformationSelector />
				<div class="flex">
					<WhisperingButton
						tooltipContent="Toggle live recording"
						onclick={() => {
							// TODO: Implement live recording toggle
							alert('Live recording not yet implemented');
						}}
						variant="ghost"
						size="icon"
						style="view-transition-name: microphone-icon"
						class="rounded-r-none border-r-0"
					>
						🎬
					</WhisperingButton>
					<RecordingModeSelector class="rounded-l-none" />
				</div>
			{/if}
		</div>
		<NavItems
			class="-mr-4"
			collapsed={isMobile.current}
			{migrationDialog}
		/>
	</div>
</header>

{@render children()}
