<script lang="ts">
	import * as Command from '@epicenter/ui/command';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderPlusIcon from '@lucide/svelte/icons/folder-plus';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { notesState } from '$lib/state/notes.svelte';

	let { open = $bindable(false) }: { open: boolean } = $props();
</script>

<Command.Dialog bind:open>
	<Command.Input placeholder="Search notes..." />
	<Command.List>
		<Command.Empty>No results found.</Command.Empty>

		<Command.Group heading="Folders">
			<Command.Item
				onSelect={() => {
					notesState.selectFolder(null);
					open = false;
				}}
			>
				<FileTextIcon class="mr-2 size-4" />
				All Notes
			</Command.Item>
			{#each notesState.folders as folder (folder.id)}
				<Command.Item
					onSelect={() => {
						notesState.selectFolder(folder.id);
						open = false;
					}}
				>
					{#if folder.icon}
						<span class="mr-2 text-base leading-none">{folder.icon}</span>
					{:else}
						<FolderIcon class="mr-2 size-4" />
					{/if}
					{folder.name}
				</Command.Item>
			{/each}
		</Command.Group>

		<Command.Separator />

		<Command.Group heading="Notes">
			{#each notesState.notes as note (note.id)}
				<Command.Item
					onSelect={() => {
					notesState.selectNote(note.id);
						open = false;
					}}
				>
					<FileTextIcon class="mr-2 size-4" />
					<div class="flex flex-col">
						<span>{note.title || 'Untitled'}</span>
						{#if note.preview}
							<span class="text-muted-foreground line-clamp-1 text-xs"
								>{note.preview}</span
							>
						{/if}
					</div>
				</Command.Item>
			{/each}
		</Command.Group>

		<Command.Separator />

		<Command.Group heading="Actions">
			<Command.Item
				onSelect={() => {
				notesState.createNote();
					open = false;
				}}
			>
				<PlusIcon class="mr-2 size-4" />
				New Note
			</Command.Item>
			<Command.Item
				onSelect={() => {
				notesState.createFolder();
					open = false;
				}}
			>
				<FolderPlusIcon class="mr-2 size-4" />
				New Folder
			</Command.Item>
		</Command.Group>
	</Command.List>
</Command.Dialog>
