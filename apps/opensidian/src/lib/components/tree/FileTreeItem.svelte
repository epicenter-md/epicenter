<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import * as TreeView from '@epicenter/ui/tree-view';
	import { fsState } from '$lib/state/fs-state.svelte';
	import { getFileIcon } from '$lib/utils/file-icons';
	import FileTreeItem from './FileTreeItem.svelte';
	import InlineNameInput from './InlineNameInput.svelte';

	let { id }: { id: FileId } = $props();

	const row = $derived(fsState.getFile(id));
	const isFolder = $derived(row?.type === 'folder');
	const isExpanded = $derived(fsState.isExpanded(id));
	const isSelected = $derived(fsState.activeFileId === id);
	const children = $derived(isFolder ? fsState.getChildren(id) : []);
	const isFocused = $derived(fsState.focusedId === id);
	const isRenaming = $derived(fsState.renamingId === id);
	const showInlineCreate = $derived(fsState.inlineCreate?.parentId === id);
	const isContextTarget = $derived(fsState.contextMenuTargetId === id);

	/** Whether this item should show the highlight background. */
	const isHighlighted = $derived(isSelected || isContextTarget);
</script>

{#if row}
	<ContextMenu.Root
		onOpenChange={(open) => fsState.setContextMenuTarget(open ? id : null)}
	>
		<ContextMenu.Trigger>
			{#snippet child({ props })}
				{#if isFolder && isRenaming}
					<div
						{...props}
						role="treeitem"
						aria-selected={isSelected}
						aria-expanded={isExpanded}
						class="w-full"
					>
						<InlineNameInput
							defaultValue={row.name}
							icon="folder"
							onConfirm={fsState.confirmRename}
							onCancel={fsState.cancelRename}
						/>
					</div>
				{:else if isFolder}
					<div
						{...props}
						role="treeitem"
						aria-selected={isSelected}
						aria-expanded={isExpanded}
					>
						<TreeView.Folder
							name={row.name}
							open={isExpanded}
							onOpenChange={() => fsState.toggleExpand(id)}
							class="w-full rounded-sm px-2 py-1 text-sm hover:bg-accent {isHighlighted
								? 'bg-accent text-accent-foreground'
								: ''} {isFocused ? 'ring-1 ring-ring' : ''}"
						>
							{#each children as childId (childId)}
								<FileTreeItem id={childId} />
							{/each}
							{#if showInlineCreate}
								<InlineNameInput
									icon={fsState.inlineCreate?.type ?? 'file'}
									onConfirm={fsState.confirmCreate}
									onCancel={fsState.cancelCreate}
								/>
							{/if}
						</TreeView.Folder>
					</div>
				{:else if isRenaming}
					<div
						{...props}
						role="treeitem"
						aria-selected={isSelected}
						class="w-full"
					>
						<InlineNameInput
							defaultValue={row.name}
							icon="file"
							onConfirm={fsState.confirmRename}
							onCancel={fsState.cancelRename}
						/>
					</div>
				{:else}
					<TreeView.File
						{...props}
						name={row.name}
						{id}
						class="w-full rounded-sm px-2 py-1 text-sm hover:bg-accent {isHighlighted
							? 'bg-accent text-accent-foreground'
							: ''} {isFocused ? 'ring-1 ring-ring' : ''}"
						onclick={() => fsState.selectFile(id)}
						aria-selected={isSelected}
						role="treeitem"
					>
						{#snippet icon()}
							{@const Icon = getFileIcon(row.name)}
							<Icon
								aria-hidden="true"
								class="h-4 w-4 shrink-0 text-muted-foreground"
							/>
						{/snippet}
					</TreeView.File>
				{/if}
			{/snippet}
		</ContextMenu.Trigger>
		<ContextMenu.Content
			onCloseAutoFocus={(e) => {
				if (fsState.inlineCreate || fsState.renamingId) {
					e.preventDefault();
				}
			}}
		>
			{#if isFolder}
				<ContextMenu.Item
					onclick={() => {
						fsState.focus(id);
						fsState.expand(id);
						fsState.startCreate('file');
					}}
				>
					New File
					<ContextMenu.Shortcut>N</ContextMenu.Shortcut>
				</ContextMenu.Item>
				<ContextMenu.Item
					onclick={() => {
						fsState.focus(id);
						fsState.expand(id);
						fsState.startCreate('folder');
					}}
				>
					New Folder
					<ContextMenu.Shortcut>⇧N</ContextMenu.Shortcut>
				</ContextMenu.Item>
				<ContextMenu.Separator />
			{/if}
			<ContextMenu.Item onclick={() => fsState.startRename(id)}>
				Rename
				<ContextMenu.Shortcut>F2</ContextMenu.Shortcut>
			</ContextMenu.Item>
			<ContextMenu.Item
				class="text-destructive"
				onclick={() => {
					const row = fsState.getFile(id);
					const name = row?.name ?? 'this item';
					const isFolder = row?.type === 'folder';
					confirmationDialog.open({
						title: `Delete ${name}?`,
						description: isFolder
							? 'This will delete the folder and all its contents. This action cannot be undone.'
							: 'This will delete the file. This action cannot be undone.',
						confirm: { text: 'Delete', variant: 'destructive' },
						onConfirm: () => fsState.deleteFile(id),
					});
				}}
			>
				Delete
				<ContextMenu.Shortcut>⌫</ContextMenu.Shortcut>
			</ContextMenu.Item>
		</ContextMenu.Content>
	</ContextMenu.Root>
{/if}
