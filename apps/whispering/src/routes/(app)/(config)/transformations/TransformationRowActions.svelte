<script lang="ts">
	import { confirmationDialog } from '$lib/components/ConfirmationDialog.svelte';
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import { TrashIcon } from '$lib/components/icons';
	import { Skeleton } from '@repo/ui/skeleton';
	import { rpc } from '$lib/query';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import EditTransformationModal from './EditTransformationModal.svelte';

	let { transformationId }: { transformationId: string } = $props();

	const deleteTransformation = createMutation(
		rpc.db.transformations.delete.options,
	);

	const transformationQuery = createQuery(
		rpc.db.transformations.getById(() => transformationId).options,
	);
	const transformation = $derived(transformationQuery.data);
</script>

<div class="flex items-center gap-1">
	{#if !transformation}
		<Skeleton class="size-8 md:hidden" />
		<Skeleton class="size-8" />
	{:else}
		<EditTransformationModal {transformation} />

		<WhisperingButton
			tooltipContent="Delete transformation"
			onclick={() => {
				confirmationDialog.open({
					title: 'Delete transformation',
					subtitle: 'Are you sure you want to delete this transformation?',
					confirmText: 'Delete',
					onConfirm: () =>
						deleteTransformation.mutate(transformation, {
							onSuccess: () => {
								rpc.notify.success.execute({
									title: 'Deleted transformation!',
									description:
										'Your transformation has been deleted successfully.',
								});
							},
							onError: (error) => {
								rpc.notify.error.execute({
									title: 'Failed to delete transformation!',
									description: 'Your transformation could not be deleted.',
									action: { type: 'more-details', error },
								});
							},
						}),
				});
			}}
			variant="ghost"
			size="icon"
		>
			<TrashIcon class="size-4" />
		</WhisperingButton>
	{/if}
</div>
