<script lang="ts">
	import type { Snippet } from 'svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import { createManualRecordingController } from './manual-recording-controller.svelte';
	import RecordingActionCard from './RecordingActionCard.svelte';

	let {
		status,
	}: {
		status: Snippet;
	} = $props();

	const rec = createManualRecordingController();
</script>

<RecordingActionCard
	controller={rec}
	footer={status}
	iconViewTransitionName={viewTransition.recordingMode('manual')}
/>
