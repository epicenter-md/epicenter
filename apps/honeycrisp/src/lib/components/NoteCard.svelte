<script lang="ts">
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button } from '@epicenter/ui/button';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import PinIcon from '@lucide/svelte/icons/pin';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import { format } from 'date-fns';
	import type { Note } from '$lib/workspace';
	import { notesState } from '$lib/state/notes.svelte';
	import { parseDateTime } from '$lib/utils/date';

	let { note }: { note: Note } = $props();

	const isSelected = $derived(note.id === notesState.selectedNoteId);

	let confirmingPermanentDelete = $state(false);
</script>

<ContextMenu.Root>
	<ContextMenu.Trigger>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="group relative flex cursor-pointer flex-col gap-0.5 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent/30 {isSelected
				? 'bg-accent'
				: ''}"
			onclick={() => notesState.selectNote(note.id)}
		>
			<div class="flex items-start justify-between gap-2">
				<span class="font-medium line-clamp-1">
					{#if note.pinned}
						<PinIcon class="mr-1 inline size-3 fill-current align-baseline" />
					{/if}
					{note.title || 'Untitled'}
				</span>
				<span class="shrink-0 text-xs text-muted-foreground">
					{format(parseDateTime(note.updatedAt), 'h:mm a')}
				</span>
			</div>
			<p class="line-clamp-2 text-xs text-muted-foreground">
				{note.preview || 'No content'}
			</p>

			{#if notesState.isRecentlyDeletedView}
				<div
					class="absolute bottom-1 right-2 hidden items-center gap-0.5 group-hover:flex {isSelected
						? 'flex'
						: ''}"
				>
					<Button
						variant="ghost"
						size="icon"
						class="size-6"
						onclick={(e) => {
						e.stopPropagation();
						notesState.restoreNote(note.id);
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
					class="absolute bottom-1 right-2 hidden items-center gap-0.5 group-hover:flex {isSelected
						? 'flex'
						: ''}"
				>
					<Button
						variant="ghost"
						size="icon"
						class="size-6"
						onclick={(e) => {
							e.stopPropagation();
					notesState.pinNote(note.id);
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
					notesState.softDeleteNote(note.id);
						}}
					>
						<TrashIcon class="size-3" />
					</Button>
				</div>
			{/if}
		</div>
	</ContextMenu.Trigger>

	<ContextMenu.Content class="w-48">
		{#if notesState.isRecentlyDeletedView}
			<ContextMenu.Item onclick={() => notesState.restoreNote(note.id)}>
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
			<ContextMenu.Item onclick={() => notesState.pinNote(note.id)}>
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
						onclick={() => notesState.moveNoteToFolder(note.id, undefined)}
					>
						<FileTextIcon class="mr-2 size-4" />
						Unfiled
					</ContextMenu.Item>
					<ContextMenu.Separator />
					{#each notesState.folders as folder (folder.id)}
						<ContextMenu.Item
							onclick={() => notesState.moveNoteToFolder(note.id, folder.id)}
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
				onclick={() => notesState.softDeleteNote(note.id)}
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
				onclick={() => notesState.permanentlyDeleteNote(note.id)}
				>Delete</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
