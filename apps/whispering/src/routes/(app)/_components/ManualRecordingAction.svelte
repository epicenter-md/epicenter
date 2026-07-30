<script lang="ts">
	import type { Snippet } from 'svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import { createManualRecordingController } from './manual-recording-controller.svelte';
	import RecordingActionCard from './RecordingActionCard.svelte';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();

	let {
		footer,
	}: {
		footer: Snippet;
	} = $props();

	const rec = createManualRecordingController(app);
</script>

<RecordingActionCard
	controller={rec}
	{footer}
	iconViewTransitionName={viewTransition.recordingMode('manual')}
/>
