<script lang="ts">
	import type { Note } from '@epicenter/honeycrisp';
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button } from '@epicenter/ui/button';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import * as Item from '@epicenter/ui/item';
	import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import PinIcon from '@lucide/svelte/icons/pin';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { format } from 'date-fns';
	import { getHoneycrisp } from '$lib/app.svelte.js';
	import { runHoneycrispMutation } from '$lib/mutation.js';

	const honeycrisp = getHoneycrisp();

	let {
		note,
		isSelected,
		onSelect,
	}: {
		note: Note;
		isSelected: boolean;
		onSelect: () => void;
	} = $props();

	/** Derive deleted status from the note itself, no need to check view mode. */
	const isDeleted = $derived(note.deletedAt !== null);

	let confirmingPermanentDelete = $state(false);
</script>

<ContextMenu.Root>
	<ContextMenu.Trigger>
		<Item.Root
			size="sm"
			class="cursor-pointer flex-col items-stretch gap-0.5 rounded-lg py-2 hover:bg-accent/30 {isSelected
				? 'bg-accent'
				: ''}"
			onclick={onSelect}
		>
			<div class="flex items-start justify-between gap-2">
				<span class="font-medium line-clamp-1">
					{#if note.pinned}
						<PinIcon class="mr-1 inline size-3 fill-current align-baseline" />
					{/if}
					{note.title || 'Untitled'}
				</span>
				<span class="shrink-0 text-xs text-muted-foreground">
					{format(new Date(note.updatedAt), 'h:mm a')}
				</span>
			</div>
			<Item.Description class="text-xs">
				{note.preview || 'No content'}
			</Item.Description>

			{#if isDeleted}
				<div
					class="absolute bottom-1 right-2 hidden items-center gap-0.5 group-hover/item:flex {isSelected
						? 'flex'
						: ''}"
				>
					<Button
						variant="ghost"
						size="icon"
						class="size-6"
						onclick={(e) => {
							e.stopPropagation();
							runHoneycrispMutation(
								() => honeycrisp.notes.restore(note.id),
								'Could not restore note',
							);
						}}
					>
						<ArchiveRestoreIcon class="size-3" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						class="size-6 text-destructive hover:text-destructive"
						onclick={(e) => {
							e.stopPropagation();
							confirmingPermanentDelete = true;
						}}
					>
						<TrashIcon class="size-3" />
					</Button>
				</div>
			{:else}
				<div
					class="absolute bottom-1 right-2 hidden items-center gap-0.5 group-hover/item:flex {isSelected
						? 'flex'
						: ''}"
				>
					<Button
						variant="ghost"
						size="icon"
						class="size-6"
						onclick={(e) => {
							e.stopPropagation();
							runHoneycrispMutation(
								() => honeycrisp.notes.togglePin(note.id),
								'Could not update note',
							);
						}}
					>
						<PinIcon class="size-3 {note.pinned ? 'fill-current' : ''}" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						class="size-6 text-destructive hover:text-destructive"
						onclick={(e) => {
							e.stopPropagation();
							runHoneycrispMutation(
								() => honeycrisp.notes.softDelete(note.id),
								'Could not delete note',
							);
						}}
					>
						<TrashIcon class="size-3" />
					</Button>
				</div>
			{/if}
		</Item.Root>
	</ContextMenu.Trigger>

	<ContextMenu.Content class="w-48">
		{#if isDeleted}
			<ContextMenu.Item
				onclick={() =>
					runHoneycrispMutation(
						() => honeycrisp.notes.restore(note.id),
						'Could not restore note',
					)}
			>
				<ArchiveRestoreIcon class="mr-2 size-4" />
				Restore
			</ContextMenu.Item>
			<ContextMenu.Separator />
			<ContextMenu.Item
				class="text-destructive focus:text-destructive"
				onclick={() => {
					confirmingPermanentDelete = true;
				}}
			>
				<TrashIcon class="mr-2 size-4" />
				Delete Permanently
			</ContextMenu.Item>
		{:else}
			<ContextMenu.Item
				onclick={() =>
					runHoneycrispMutation(
						() => honeycrisp.notes.togglePin(note.id),
						'Could not update note',
					)}
			>
				<PinIcon class="mr-2 size-4 {note.pinned ? 'fill-current' : ''}" />
				{note.pinned ? 'Unpin' : 'Pin'}
			</ContextMenu.Item>
			<ContextMenu.Separator />
			<ContextMenu.Sub>
				<ContextMenu.SubTrigger>
					<FolderIcon class="mr-2 size-4" />
					Move to Folder
				</ContextMenu.SubTrigger>
				<ContextMenu.SubContent class="w-48">
					<ContextMenu.Item
						onclick={() =>
							runHoneycrispMutation(
								() => honeycrisp.notes.moveToFolder(note.id, null),
								'Could not move note',
							)}
					>
						<FileTextIcon class="mr-2 size-4" />
						Unfiled
					</ContextMenu.Item>
					<ContextMenu.Separator />
					{#each honeycrisp.folders.all as folder (folder.id)}
						<ContextMenu.Item
							onclick={() =>
								runHoneycrispMutation(
									() => honeycrisp.notes.moveToFolder(note.id, folder.id),
									'Could not move note',
								)}
						>
							{#if folder.icon}
								<span class="mr-2 text-base leading-none">{folder.icon}</span>
							{:else}
								<FolderIcon class="mr-2 size-4" />
							{/if}
							{folder.name}
						</ContextMenu.Item>
					{/each}
				</ContextMenu.SubContent>
			</ContextMenu.Sub>
			<ContextMenu.Separator />
			<ContextMenu.Item
				class="text-destructive focus:text-destructive"
				onclick={() =>
					runHoneycrispMutation(
						() => honeycrisp.notes.softDelete(note.id),
						'Could not delete note',
					)}
			>
				<TrashIcon class="mr-2 size-4" />
				Delete
			</ContextMenu.Item>
		{/if}
	</ContextMenu.Content>
</ContextMenu.Root>

<AlertDialog.Root bind:open={confirmingPermanentDelete}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete Permanently?</AlertDialog.Title>
			<AlertDialog.Description>
				This note will be permanently deleted. This action cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				onclick={() =>
					runHoneycrispMutation(
						() => honeycrisp.notes.permanentlyDelete(note.id),
						'Could not permanently delete note',
					)}
				>Delete</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
