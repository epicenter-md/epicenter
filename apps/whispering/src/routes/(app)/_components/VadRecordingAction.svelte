<script lang="ts">
	import type { Snippet } from 'svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import { createVadRecordingController } from './vad-recording-controller.svelte';
	import RecordingActionCard from './RecordingActionCard.svelte';

	let {
		status,
	}: {
		status: Snippet;
	} = $props();

	const rec = createVadRecordingController();
</script>

<RecordingActionCard
	controller={rec}
	footer={status}
	iconViewTransitionName={viewTransition.recordingMode('vad')}
/>
