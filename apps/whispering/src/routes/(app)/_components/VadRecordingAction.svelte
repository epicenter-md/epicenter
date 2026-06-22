<script lang="ts">
	import VadDeviceSelector from '$lib/components/settings/selectors/VadDeviceSelector.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import CapturePipeline from './CapturePipeline.svelte';
	import { createVadRecordingController } from './vad-recording-controller.svelte';
	import RecordingActionCard from './RecordingActionCard.svelte';

	const vadRec = createVadRecordingController();
</script>

<RecordingActionCard
	controller={vadRec}
	iconViewTransitionName={viewTransition.recordingMode('vad')}
>
	{#snippet footer()}
		<CapturePipeline>
			<VadDeviceSelector
				iconViewTransitionName={viewTransition.pipeline.device}
			/>
		</CapturePipeline>
	{/snippet}
</RecordingActionCard>
