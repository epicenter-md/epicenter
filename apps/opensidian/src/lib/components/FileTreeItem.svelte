<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import * as TreeView from '@epicenter/ui/tree-view';
	import { getFileIcon } from '$lib/fs/file-icons';
	import { fsState } from '$lib/fs/fs-state.svelte';
	import CreateDialog from './CreateDialog.svelte';
	import DeleteConfirmation from './DeleteConfirmation.svelte';
	import FileTreeItem from './FileTreeItem.svelte';
	import RenameDialog from './RenameDialog.svelte';

	let { id }: { id: FileId } = $props();

	const row = $derived(fsState.getRow(id));
	const isFolder = $derived(row?.type === 'folder');
	const isExpanded = $derived(fsState.expandedIds.has(id));
	const isSelected = $derived(fsState.activeFileId === id);
	const children = $derived(isFolder ? fsState.getChildIds(id) : []);
	const isFocused = $derived(fsState.focusedId === id);

	let createDialogOpen = $state(false);
	let createDialogMode = $state<'file' | 'folder'>('file');
	let renameDialogOpen = $state(false);
	let deleteDialogOpen = $state(false);

	function selectAndOpenCreate(mode: 'file' | 'folder') {
		fsState.actions.selectFile(id);
		createDialogMode = mode;
		createDialogOpen = true;
	}

	function selectAndOpenRename() {
		fsState.actions.selectFile(id);
		renameDialogOpen = true;
	}

	function selectAndOpenDelete() {
		fsState.actions.selectFile(id);
		deleteDialogOpen = true;
	}
</script>

{#if row}
	<ContextMenu.Root>
		<ContextMenu.Trigger>
			{#snippet child({ props })}
				{#if isFolder}
					<div {...props} role="treeitem" aria-expanded={isExpanded}>
						<TreeView.Folder
							name={row.name}
							open={isExpanded}
							onOpenChange={() => fsState.actions.toggleExpand(id)}
							class="w-full rounded-sm px-2 py-1 text-sm hover:bg-accent {isSelected
								? 'bg-accent text-accent-foreground'
								: ''} {isFocused ? 'ring-1 ring-ring' : ''}"
						>
							{#each children as childId (childId)}
								<FileTreeItem id={childId} />
							{/each}
						</TreeView.Folder>
					</div>
				{:else}
					<TreeView.File
						{...props}
						name={row.name}
						id={id}
						class="w-full rounded-sm px-2 py-1 text-sm hover:bg-accent {isSelected
							? 'bg-accent text-accent-foreground'
							: ''} {isFocused ? 'ring-1 ring-ring' : ''}"
						onclick={() => fsState.actions.selectFile(id)}
						role="treeitem"
					>
						{#snippet icon()}
							{@const Icon = getFileIcon(row.name)}
							<Icon class="h-4 w-4 shrink-0 text-muted-foreground" />
						{/snippet}
					</TreeView.File>
				{/if}
			{/snippet}
		</ContextMenu.Trigger>
		<ContextMenu.Content>
			{#if isFolder}
				<ContextMenu.Item onclick={() => selectAndOpenCreate('file')}>
					New File
				</ContextMenu.Item>
				<ContextMenu.Item onclick={() => selectAndOpenCreate('folder')}>
					New Folder
				</ContextMenu.Item>
				<ContextMenu.Separator />
			{/if}
			<ContextMenu.Item onclick={selectAndOpenRename}>Rename</ContextMenu.Item>
			<ContextMenu.Item class="text-destructive" onclick={selectAndOpenDelete}>
				Delete
			</ContextMenu.Item>
		</ContextMenu.Content>
	</ContextMenu.Root>

	<CreateDialog bind:open={createDialogOpen} mode={createDialogMode} />
	<RenameDialog bind:open={renameDialogOpen} />
	<DeleteConfirmation bind:open={deleteDialogOpen} />
{/if}
