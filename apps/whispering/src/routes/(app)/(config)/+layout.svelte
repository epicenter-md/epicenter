<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { cn } from '@epicenter/ui/utils';
	import XIcon from '@lucide/svelte/icons/x';
	import { commandCallbacks } from '$lib/commands';
	import ImportFileButton from '$lib/components/ImportFileButton.svelte';
	import {
		CaptureSurfaceSelector,
		TranscriptionSelector,
	} from '$lib/components/settings';
	import ManualDeviceSelector from '$lib/components/settings/selectors/ManualDeviceSelector.svelte';
	import VadDeviceSelector from '$lib/components/settings/selectors/VadDeviceSelector.svelte';
	import {
		MANUAL_RECORDING_BUTTON,
		VAD_RECORDING_BUTTON,
	} from '$lib/constants/audio';
	import { captureSurface } from '$lib/state/capture-surface.svelte';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';
	import { vadRecorder } from '$lib/state/vad-recorder.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';

	let { children } = $props();

	const ManualButtonIcon = $derived(
		MANUAL_RECORDING_BUTTON[manualRecorder.state].Icon,
	);
	const VadButtonIcon = $derived(VAD_RECORDING_BUTTON[vadRecorder.state].Icon);
</script>

<header
	class={cn(
		'border-border/40 bg-background/95 supports-backdrop-filter:bg-background/60 z-10 border-b shadow-xs backdrop-blur-sm',
		'flex h-14 w-full items-center justify-between px-4 sm:px-8',
	)}
>
	<Button tooltip="Go home" href="/" variant="ghost" class="-ml-4">
		<span class="text-lg font-bold">whispering</span>
	</Button>

	<div class="flex items-center gap-1.5">
		{#if captureSurface.current === 'manual'}
			{#if manualRecorder.state === 'RECORDING'}
				<Button
					tooltip="Cancel recording"
					onclick={() => commandCallbacks.cancelRecording()}
					variant="ghost"
					size="icon"
				>
					<XIcon class="size-4" />
				</Button>
				<Button
					tooltip="Stop recording"
					onclick={() => commandCallbacks.toggleManualRecording()}
					variant="ghost"
					size="icon"
				>
					<ManualButtonIcon class="size-4" />
				</Button>
			{:else}
				<ManualDeviceSelector
					iconViewTransitionName={viewTransition.pipeline.device}
				/>
				<TranscriptionSelector
					variant="standalone"
					iconViewTransitionName={viewTransition.pipeline.transcription}
				/>
				<div class="flex">
					<Button
						tooltip="Start recording"
						onclick={() => commandCallbacks.toggleManualRecording()}
						variant="ghost"
						size="icon"
						class="rounded-r-none border-r-0"
					>
						<span
							class="inline-flex shrink-0"
							style:view-transition-name={viewTransition.recordingMode('manual')}
						>
							<ManualButtonIcon class="size-4" />
						</span>
					</Button>
					<CaptureSurfaceSelector class="rounded-l-none" />
				</div>
			{/if}
		{:else if captureSurface.current === 'vad'}
			{#if vadRecorder.state === 'IDLE'}
				<VadDeviceSelector
					iconViewTransitionName={viewTransition.pipeline.device}
				/>
				<TranscriptionSelector
					variant="standalone"
					iconViewTransitionName={viewTransition.pipeline.transcription}
				/>
				<div class="flex">
					<Button
						tooltip="Start voice activated recording"
						onclick={() => commandCallbacks.toggleVadRecording()}
						variant="ghost"
						size="icon"
						class="rounded-r-none border-r-0"
					>
						<span
							class="inline-flex shrink-0"
							style:view-transition-name={viewTransition.recordingMode('vad')}
						>
							<VadButtonIcon class="size-4" />
						</span>
					</Button>
					<CaptureSurfaceSelector class="rounded-l-none" />
				</div>
			{:else}
				<Button
					tooltip="Stop voice activated recording"
					onclick={() => commandCallbacks.toggleVadRecording()}
					variant="ghost"
					size="icon"
				>
					<VadButtonIcon class="size-4" />
				</Button>
			{/if}
		{:else if captureSurface.current === 'import'}
			<TranscriptionSelector
				variant="standalone"
				iconViewTransitionName={viewTransition.pipeline.transcription}
			/>
			<div class="flex">
				<ImportFileButton class="rounded-r-none border-r-0" />
				<CaptureSurfaceSelector class="rounded-l-none" />
			</div>
		{/if}
	</div>
</header>

<div class="flex-1 overflow-x-auto">{@render children()}</div>
