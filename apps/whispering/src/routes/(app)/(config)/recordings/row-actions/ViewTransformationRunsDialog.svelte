<script lang="ts">
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import { Runs } from '$lib/components/transformations-editor';
	import { Button } from '@repo/ui/button';
	import * as Dialog from '@repo/ui/dialog';
	import { rpc } from '$lib/query';
	import { createQuery } from '@tanstack/svelte-query';
	import { HistoryIcon } from '@lucide/svelte';

	let { recordingId }: { recordingId: string } = $props();

	const transformationRunsByRecordingIdQuery = createQuery(
		rpc.db.runs.getByRecordingId(() => recordingId).options,
	);

	let isOpen = $state(false);
</script>

<Dialog.Root bind:open={isOpen}>
	<Dialog.Trigger>
		{#snippet child({ props })}
			<WhisperingButton
				{...props}
				variant="ghost"
				size="icon"
				tooltipContent="View Transformation Runs"
			>
				<HistoryIcon class="size-4" />
			</WhisperingButton>
		{/snippet}
	</Dialog.Trigger>
	<Dialog.Content class="sm:max-w-4xl">
		<Dialog.Header>
			<Dialog.Title>Transformation Runs</Dialog.Title>
			<Dialog.Description>
				View all transformation runs for this recording
			</Dialog.Description>
		</Dialog.Header>
		<div class="max-h-[60vh] overflow-y-auto">
			{#if transformationRunsByRecordingIdQuery.isPending}
				<div class="text-muted-foreground text-sm">Loading runs...</div>
			{:else if transformationRunsByRecordingIdQuery.error}
				<div class="text-destructive text-sm">
					{transformationRunsByRecordingIdQuery.error.message}
				</div>
			{:else if transformationRunsByRecordingIdQuery.data}
				<Runs runs={transformationRunsByRecordingIdQuery.data} />
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (isOpen = false)}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
