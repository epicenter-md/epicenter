<script lang="ts">
	import {
		CommandPalette as UiCommandPalette,
		type CommandPaletteItem,
	} from '@epicenter/ui/command-palette';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderPlusIcon from '@lucide/svelte/icons/folder-plus';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { getNotesSurface } from '../state/index.js';
	import { runHoneycrispMutation } from '$lib/mutation.js';

	const surface = getNotesSurface();

	let isOpen = $state(false);

	function createAndSelectNote(): void {
		const { id } = surface.state.notes.create(
			surface.state.view.selectedFolderId,
		);
		surface.state.view.selectNote(id);
	}

	const items = $derived.by((): CommandPaletteItem[] => [
		{
			id: 'folder:all',
			label: 'All Notes',
			group: 'Folders',
			icon: FileTextIcon,
			onSelect: () => surface.state.view.selectFolder(null),
		},
		...surface.state.folders.all.map((folder): CommandPaletteItem => ({
			id: `folder:${folder.id}`,
			label: folder.icon ? `${folder.icon} ${folder.name}` : folder.name,
			keywords: [folder.name],
			group: 'Folders',
			icon: folder.icon ? undefined : FolderIcon,
			onSelect: () => surface.state.view.selectFolder(folder.id),
		})),
		...surface.state.notes.all.map((note): CommandPaletteItem => ({
			id: `note:${note.id}`,
			label: note.title || 'Untitled',
			description: note.preview || undefined,
			group: 'Notes',
			icon: FileTextIcon,
			onSelect: () => surface.state.view.selectNote(note.id),
		})),
		{
			id: 'action:new-note',
			label: 'New Note',
			group: 'Actions',
			icon: PlusIcon,
			onSelect: () =>
				runHoneycrispMutation(() => createAndSelectNote(), 'Could not create note'),
		},
		{
			id: 'action:new-folder',
			label: 'New Folder',
			group: 'Actions',
			icon: FolderPlusIcon,
			onSelect: () =>
				runHoneycrispMutation(
					() => surface.state.folders.create(),
					'Could not create folder',
				),
		},
	]);
</script>

<UiCommandPalette
	{items}
	bind:open={isOpen}
	placeholder="Search notes..."
	emptyMessage="No results found."
	title="Search Notes"
	description="Search folders, notes, and actions"
/>
