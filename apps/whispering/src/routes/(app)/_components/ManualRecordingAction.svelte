<script lang="ts">
	import ManualDeviceSelector from '$lib/components/settings/selectors/ManualDeviceSelector.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import CapturePipeline from './CapturePipeline.svelte';
	import { createManualRecordingController } from './manual-recording-controller.svelte';
	import RecordingActionCard from './RecordingActionCard.svelte';

	const rec = createManualRecordingController();
</script>

<RecordingActionCard
	controller={rec}
	iconViewTransitionName={viewTransition.recordingMode('manual')}
>
	{#snippet footer()}
		<CapturePipeline>
			<ManualDeviceSelector
				iconViewTransitionName={viewTransition.pipeline.device}
			/>
		</CapturePipeline>
	{/snippet}
</RecordingActionCard>
