<script lang="ts">
	import { confirmationDialog } from '$lib/components/ConfirmationDialog.svelte';
	import WhisperingButton from '$lib/components/WhisperingButton.svelte';
	import { PencilIcon as EditIcon } from '$lib/components/icons';
	import { Editor } from '$lib/components/transformations-editor';
	import { Button } from '@repo/ui/button';
	import * as Modal from '@repo/ui/modal';
	import { Separator } from '@repo/ui/separator';
	import { rpc } from '$lib/query';
	import type { Transformation } from '$lib/services/db';
	import { createMutation } from '@tanstack/svelte-query';
	import {
		HistoryIcon,
		Loader2Icon,
		PlayIcon,
		TrashIcon,
	} from '@lucide/svelte';
	import MarkTransformationActiveButton from './MarkTransformationActiveButton.svelte';

	const updateTransformation = createMutation(
		rpc.db.transformations.update.options,
	);

	const deleteTransformation = createMutation(
		rpc.db.transformations.delete.options,
	);

	let {
		transformation,
		class: className,
	}: { transformation: Transformation; class?: string } = $props();

	let isDialogOpen = $state(false);

	/**
	 * A working copy of the transformation that we can safely edit.
	 *
	 * It's like a photocopy of an important document—you don't want to
	 * accidentally mess up the original. You edit the photocopy, submit it,
	 * and the original is updated. Then you get a new photocopy.
	 *
	 * Here's how it works:
	 * 1. We get the original transformation data
	 * 2. We make a copy of it (this variable)
	 * 3. User makes changes to the copy
	 * 4. When they save, we send the copy via mutation
	 * 5. The mutation updates the original transformation
	 * 6. We get the fresh original data back and make a new copy (via $derived)
	 */
	let workingCopy = $derived(
		// Reset the working copy when new transformation data comes in.
		transformation,
	);

	/**
	 * Tracks whether the user has made changes to the working copy.
	 *
	 * Think of this like a "dirty" flag on a document - it tells us if
	 * the user has made edits that haven't been saved yet.
	 *
	 * How it works:
	 * - Starts as false when we get fresh data from the upstream transformation
	 * - Becomes true as soon as the user edits anything
	 * - Goes back to false when they save or when fresh data comes in
	 *
	 * We use this to:
	 * - Show confirmation dialogs before closing unsaved work
	 * - Disable the save button when there's nothing to save
	 * - Reset the working copy when new data arrives
	 */
	let isWorkingCopyDirty = $derived.by(() => {
		// Reset dirty flag when new transformation data comes in
		transformation;
		return false;
	});

	function promptUserConfirmLeave() {
		if (!isWorkingCopyDirty) {
			isDialogOpen = false;
			return;
		}

		confirmationDialog.open({
			title: 'Unsaved changes',
			subtitle: 'You have unsaved changes. Are you sure you want to leave?',
			confirmText: 'Leave',
			onConfirm: () => {
				// Reset working copy and dirty flag
				workingCopy = transformation;
				isWorkingCopyDirty = false;

				isDialogOpen = false;
			},
		});
	}
</script>

<Modal.Root bind:open={isDialogOpen}>
	<Modal.Trigger>
		{#snippet child({ props })}
			<WhisperingButton
				{...props}
				tooltipContent="Edit transformation, test transformation, and view run history"
				variant="ghost"
				class={className}
			>
				<EditIcon class="size-4" />
				<PlayIcon class="size-4" />
				<HistoryIcon class="size-4" />
			</WhisperingButton>
		{/snippet}
	</Modal.Trigger>

	<Modal.Content
		class="max-h-[80vh] sm:max-w-7xl"
		onEscapeKeydown={(e) => {
			e.preventDefault();
			if (isDialogOpen) {
				promptUserConfirmLeave();
			}
		}}
		onInteractOutside={(e) => {
			e.preventDefault();
			if (isDialogOpen) {
				promptUserConfirmLeave();
			}
		}}
	>
		<Modal.Header>
			<Modal.Title>Transformation Settings</Modal.Title>
			<Separator />
		</Modal.Header>

		<Editor
			bind:transformation={
				() => workingCopy,
				(v) => {
					workingCopy = v;
					isWorkingCopyDirty = true;
				}
			}
		/>

		<Modal.Footer>
			<Button
				onclick={() => {
					confirmationDialog.open({
						title: 'Delete transformation',
						subtitle: 'Are you sure? This action cannot be undone.',
						confirmText: 'Delete',
						onConfirm: () => {
							deleteTransformation.mutate($state.snapshot(transformation), {
								onSuccess: () => {
									isDialogOpen = false;
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
							});
						},
					});
				}}
				variant="destructive"
				disabled={deleteTransformation.isPending}
			>
				{#if deleteTransformation.isPending}
					<Loader2Icon class="mr-2 size-4 animate-spin" />
				{:else}
					<TrashIcon class="size-4 mr-1" />
				{/if}
				Delete
			</Button>
			<div class="flex items-center gap-2">
				<MarkTransformationActiveButton {transformation} />
				<Button variant="outline" onclick={() => promptUserConfirmLeave()}>
					Close
				</Button>
				<Button
					onclick={() => {
						updateTransformation.mutate($state.snapshot(workingCopy), {
							onSuccess: () => {
								rpc.notify.success.execute({
									title: 'Updated transformation!',
									description:
										'Your transformation has been updated successfully.',
								});
								isDialogOpen = false;
							},
							onError: (error) => {
								rpc.notify.error.execute({
									title: 'Failed to update transformation!',
									description: 'Your transformation could not be updated.',
									action: { type: 'more-details', error },
								});
							},
						});
					}}
					disabled={updateTransformation.isPending || !isWorkingCopyDirty}
				>
					{#if updateTransformation.isPending}
						<Loader2Icon class="mr-2 size-4 animate-spin" />
					{/if}
					Save
				</Button>
			</div>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
