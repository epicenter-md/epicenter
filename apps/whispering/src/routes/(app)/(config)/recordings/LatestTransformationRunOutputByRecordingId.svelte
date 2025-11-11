<script lang="ts">
	import TextPreviewDialog from '$lib/components/copyable/TextPreviewDialog.svelte';
	import { Skeleton } from '@repo/ui/skeleton';
	import { rpc } from '$lib/query';
	import { getRecordingTransitionId } from '$lib/utils/getRecordingTransitionId';
	import { createQuery } from '@tanstack/svelte-query';

	let {
		recordingId,
	}: {
		recordingId: string;
	} = $props();

	const latestTransformationRunByRecordingIdQuery = createQuery(
		rpc.db.runs.getLatestByRecordingId(() => recordingId).options,
	);

	const id = getRecordingTransitionId({
		recordingId,
		propertyName: 'latestTransformationRunOutput',
	});
</script>

{#if latestTransformationRunByRecordingIdQuery.isPending}
	<div class="space-y-2">
		<Skeleton class="h-3" />
		<Skeleton class="h-3" />
		<Skeleton class="h-3" />
	</div>
{:else if latestTransformationRunByRecordingIdQuery.error}
	<TextPreviewDialog
		{id}
		title="Query Error"
		label="query error"
		text={latestTransformationRunByRecordingIdQuery.error.message}
	/>
{:else if latestTransformationRunByRecordingIdQuery.data?.status === 'failed'}
	<TextPreviewDialog
		{id}
		title="Transformation Error"
		label="transformation error"
		text={latestTransformationRunByRecordingIdQuery.data.error}
	/>
{:else if latestTransformationRunByRecordingIdQuery.data?.status === 'completed'}
	<TextPreviewDialog
		{id}
		title="Transformation Output"
		label="transformation output"
		text={latestTransformationRunByRecordingIdQuery.data.output}
	/>
{/if}
