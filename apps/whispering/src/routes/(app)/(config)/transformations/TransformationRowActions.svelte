<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { rpc } from '$lib/query';
	import { transformations } from '$lib/state/transformations.svelte';
	import EditTransformationModal from './EditTransformationModal.svelte';

	let { transformationId }: { transformationId: string } = $props();

	const transformation = $derived(transformations.get(transformationId));
</script>

<div class="flex items-center gap-1">
	{#if !transformation}
		<Skeleton class="size-8 md:hidden" />
		<Skeleton class="size-8" />
	{:else}
		<EditTransformationModal {transformation} />

		<Button
			tooltip="Delete transformation"
			onclick={() => {
				confirmationDialog.open({
					title: 'Delete transformation',
					description: 'Are you sure you want to delete this transformation?',
					confirm: { text: 'Delete', variant: 'destructive' },
					onConfirm: () => {
						transformations.delete(transformation.id);
						rpc.notify.success({
							title: 'Deleted transformation!',
							description: 'Your transformation has been deleted successfully.',
						});
					},
				});
			}}
			variant="ghost"
			size="icon"
		>
			<TrashIcon class="size-4" />
		</Button>
	{/if}
</div>
