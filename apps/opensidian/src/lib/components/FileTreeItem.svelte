<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import * as TreeView from '@epicenter/ui/tree-view';
	import { getFileIcon } from '$lib/fs/file-icons';
	import { fsState } from '$lib/fs/fs-state.svelte';
	import DeleteConfirmation from './DeleteConfirmation.svelte';
	import FileTreeItem from './FileTreeItem.svelte';
	import InlineNameInput from './InlineNameInput.svelte';

	let { id }: { id: FileId } = $props();

	const row = $derived(fsState.getRow(id));
	const isFolder = $derived(row?.type === 'folder');
	const isExpanded = $derived(fsState.expandedIds.has(id));
	const isSelected = $derived(fsState.activeFileId === id);
	const children = $derived(isFolder ? fsState.getChildIds(id) : []);
	const isFocused = $derived(fsState.focusedId === id);
	const isRenaming = $derived(fsState.renamingId === id);
	const showInlineCreate = $derived(fsState.inlineCreate?.parentId === id);

	let deleteDialogOpen = $state(false);
</script>

{#if row}
	<ContextMenu.Root>
		<ContextMenu.Trigger>
			{#snippet child({ props })}
				{#if isFolder && isRenaming}
					<div {...props} role="treeitem" aria-expanded={isExpanded} class="w-full">
						<InlineNameInput
							defaultValue={row.name}
							icon="folder"
							onConfirm={fsState.actions.confirmRename}
							onCancel={fsState.actions.cancelRename}
						/>
					</div>
				{:else if isFolder}
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
							{#if showInlineCreate}
								<InlineNameInput
									icon={fsState.inlineCreate?.type ?? 'file'}
									onConfirm={fsState.actions.confirmCreate}
									onCancel={fsState.actions.cancelCreate}
								/>
							{/if}
						</TreeView.Folder>
					</div>
				{:else if isRenaming}
					<div {...props} role="treeitem" class="w-full">
						<InlineNameInput
							defaultValue={row.name}
							icon="file"
						onConfirm={fsState.actions.confirmRename}
						onCancel={fsState.actions.cancelRename}
						/>
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
				<ContextMenu.Item onclick={() => {
					fsState.actions.focus(id);
					fsState.expandedIds.add(id);
					fsState.actions.startCreate('file');
				}}>
					New File
					<ContextMenu.Shortcut>N</ContextMenu.Shortcut>
				</ContextMenu.Item>
				<ContextMenu.Item onclick={() => {
					fsState.actions.focus(id);
					fsState.expandedIds.add(id);
					fsState.actions.startCreate('folder');
				}}>
					New Folder
					<ContextMenu.Shortcut>⇧N</ContextMenu.Shortcut>
				</ContextMenu.Item>
				<ContextMenu.Separator />
			{/if}
			<ContextMenu.Item onclick={() => fsState.actions.startRename(id)}>
				Rename
				<ContextMenu.Shortcut>F2</ContextMenu.Shortcut>
			</ContextMenu.Item>
			<ContextMenu.Item
				class="text-destructive"
				onclick={() => {
					fsState.actions.selectFile(id);
					deleteDialogOpen = true;
				}}
			>
				Delete
				<ContextMenu.Shortcut>⌫</ContextMenu.Shortcut>
			</ContextMenu.Item>
		</ContextMenu.Content>
	</ContextMenu.Root>

	<DeleteConfirmation bind:open={deleteDialogOpen} />
{/if}
