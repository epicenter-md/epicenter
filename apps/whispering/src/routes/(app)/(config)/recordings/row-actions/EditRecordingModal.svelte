<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as Modal from '@epicenter/ui/modal';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Textarea } from '@epicenter/ui/textarea';
	import EditIcon from '@lucide/svelte/icons/pencil';
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { rpc } from '$lib/query';
	import { services } from '$lib/services';
	import { type Recording, recordings } from '$lib/state/recordings.svelte';
	import { recordingActions } from '$lib/utils/recording-actions';

	let { recording }: { recording: Recording } = $props();

	/**
	 * Capture the recording ID at setup time for use in cleanup.
	 *
	 * Reactive props ($props) can become undefined during Svelte's teardown
	 * when the parent's data source is deleted (e.g. deleting a recording
	 * causes the table row—and this component—to unmount). If onDestroy
	 * reads the prop directly, it may see undefined and throw. Capturing
	 * the ID here sidesteps the reactive teardown race entirely.
	 */
	const recordingIdForCleanup = recording.id;

	let isDialogOpen = $state(false);

	/**
	 * A working copy of the recording that we can safely edit.
	 *
	 * It's like a photocopy of an important document—you don't want to
	 * accidentally mess up the original. You edit the photocopy, submit it,
	 * and the original is updated. Then you get a new photocopy.
	 *
	 * Here's how it works:
	 * 1. We get the original recording data
	 * 2. We make a copy of it (this variable)
	 * 3. User makes changes to the copy
	 * 4. When they save, we send the copy via mutation
	 * 5. The mutation updates the original recording
	 * 6. We get the fresh original data back and make a new copy (via $derived)
	 */
	let workingCopy = $derived(
		// Reset the working copy when new recording data comes in.
		recording,
	);

	/**
	 * Tracks whether the user has made changes to the working copy.
	 *
	 * Think of this like a "dirty" flag on a document - it tells us if
	 * the user has made edits that haven't been saved yet.
	 *
	 * How it works:
	 * - Starts as false when we get fresh data from the upstream recording
	 * - Becomes true as soon as the user edits anything
	 * - Goes back to false when they save or when fresh data comes in
	 *
	 * We use this to:
	 * - Show confirmation dialogs before closing unsaved work
	 * - Disable the save button when there's nothing to save
	 * - Reset the working copy when new data arrives
	 */
	let isWorkingCopyDirty = $derived.by(() => {
		// Reset dirty flag when new recording data comes in
		recording;
		return false;
	});

	/**
	 * Audio playback URL via TanStack Query.
	 * Audio blobs are too large for Yjs CRDTs, so they're still served
	 * from DbService. Uses accessor pattern for reactive updates.
	 */
	const audioPlaybackUrlQuery = createQuery(
		() => rpc.audio.getPlaybackUrl(() => recording.id).options,
	);

	const audioUrl = $derived(audioPlaybackUrlQuery.data);

	function promptUserConfirmLeave() {
		if (!isWorkingCopyDirty) {
			isDialogOpen = false;
			return;
		}

		confirmationDialog.open({
			title: 'Unsaved changes',
			description: 'You have unsaved changes. Are you sure you want to leave?',
			confirm: { text: 'Leave' },
			onConfirm: () => {
				// Reset working copy and dirty flag
				workingCopy = recording;
				isWorkingCopyDirty = false;

				isDialogOpen = false;
			},
		});
	}

	onDestroy(() => {
		services.db.recordings.revokeAudioUrl(recordingIdForCleanup);
	});
</script>

<Modal.Root bind:open={isDialogOpen}>
	<Modal.Trigger>
		{#snippet child({ props })}
			<Button tooltip="Edit recording" variant="ghost" size="icon" {...props}>
				<EditIcon class="size-4" />
			</Button>
		{/snippet}
	</Modal.Trigger>
	<Modal.Content
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
			<Modal.Title>Edit recording</Modal.Title>
			<Modal.Description>
				Make changes to your recording and click save when you're done.
			</Modal.Description>
		</Modal.Header>
		<div class="space-y-4 p-4">
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="title" class="text-right">Title</Label>
				<Input
					id="title"
					value={workingCopy.title}
					oninput={(e) => {
						workingCopy = { ...workingCopy, title: e.currentTarget.value };
						isWorkingCopyDirty = true;
					}}
					class="col-span-3"
				/>
			</div>
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="subtitle" class="text-right">Subtitle</Label>
				<Input
					id="subtitle"
					value={workingCopy.subtitle}
					oninput={(e) => {
						workingCopy = { ...workingCopy, subtitle: e.currentTarget.value };
						isWorkingCopyDirty = true;
					}}
					class="col-span-3"
				/>
			</div>
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="timestamp" class="text-right">Created At</Label>
				<Input
					id="timestamp"
					value={workingCopy.timestamp}
					oninput={(e) => {
						workingCopy = { ...workingCopy, timestamp: e.currentTarget.value };
						isWorkingCopyDirty = true;
					}}
					class="col-span-3"
				/>
			</div>
			<div class="grid grid-cols-4 items-center gap-4">
				<Label for="transcribedText" class="text-right">Transcript</Label>
				<Textarea
					id="transcribedText"
					value={workingCopy.transcribedText}
					oninput={(e) => {
						workingCopy = {
							...workingCopy,
							transcribedText: e.currentTarget.value,
						};
						isWorkingCopyDirty = true;
					}}
					class="col-span-3"
				/>
			</div>
			{#if audioUrl}
				<div class="grid grid-cols-4 items-center gap-4">
					<Label for="audio" class="text-right">Audio</Label>
					<audio src={audioUrl} controls class="col-span-3 h-8 w-full"></audio>
				</div>
			{/if}
		</div>
		<Modal.Footer>
			<Button
				onclick={() =>
					recordingActions.deleteWithConfirmation(
						$state.snapshot(recording),
						{ onSuccess: () => { isDialogOpen = false; } },
					)}
				variant="destructive"
			>
				Delete
			</Button>
			<Button variant="outline" onclick={() => promptUserConfirmLeave()}>
				Close
			</Button>
			<Button
				onclick={() => {
				recordings.set($state.snapshot(workingCopy));
				rpc.notify.success({
					title: 'Updated recording!',
					description: 'Your recording has been updated successfully.',
				});
				isDialogOpen = false;
			}}
				disabled={!isWorkingCopyDirty}
			>
				Save
			</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
