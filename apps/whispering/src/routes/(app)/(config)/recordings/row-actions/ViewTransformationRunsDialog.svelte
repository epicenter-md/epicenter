<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Modal from '@epicenter/ui/modal';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import { Runs } from '$lib/components/transformations-editor';
	import { transformationRuns } from '$lib/state/transformation-runs.svelte';

	let { recordingId }: { recordingId: string } = $props();

	const runs = $derived(transformationRuns.getByRecordingId(recordingId));

	let isOpen = $state(false);
</script>

<Modal.Root bind:open={isOpen}>
	<Modal.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon"
				tooltip="View Transformation Runs"
			>
				<HistoryIcon class="size-4" />
			</Button>
		{/snippet}
	</Modal.Trigger>
	<Modal.Content class="sm:max-w-4xl">
		<Modal.Header>
			<Modal.Title>Transformation Runs</Modal.Title>
			<Modal.Description>
				View all transformation runs for this recording
			</Modal.Description>
		</Modal.Header>
		<div class="max-h-[60vh] overflow-y-auto"><Runs {runs} /></div>
		<Modal.Footer>
			<Button variant="outline" onclick={() => (isOpen = false)}>Close</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
