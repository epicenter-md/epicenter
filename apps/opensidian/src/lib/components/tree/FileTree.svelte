<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as TreeView from '@epicenter/ui/tree-view';
	import { fsState } from '$lib/state/fs-state.svelte';
	import { sampleDataLoader } from '$lib/utils/load-sample-data.svelte';
	import FileTreeItem from './FileTreeItem.svelte';
	import InlineNameInput from './InlineNameInput.svelte';

	/**
	 * Flat list of visible item IDs in visual order.
	 * Respects folder expansion state—collapsed folders hide their descendants.
	 */
	const visibleIds = $derived.by(() => {
		return fsState.walkTree<FileId>((id, row) => ({
			collect: id,
			descend: row.type === 'folder' && fsState.isExpanded(id),
		}));
	});

	/** Whether an inline create/rename is active (suppresses tree keyboard shortcuts). */
	const isEditing = $derived(
		fsState.inlineCreate !== null || fsState.renamingId !== null,
	);

	function handleKeydown(e: KeyboardEvent) {
		// Don't intercept keys while inline editing is active
		if (isEditing) return;

		const current = fsState.focusedId;
		const currentIndex = current ? visibleIds.indexOf(current) : -1;

		switch (e.key) {
			case 'ArrowDown': {
				e.preventDefault();
				if (currentIndex === -1) {
					fsState.focus(visibleIds[0] ?? null);
				} else {
					const next =
						visibleIds[Math.min(currentIndex + 1, visibleIds.length - 1)];
					fsState.focus(next ?? null);
				}
				break;
			}
			case 'ArrowUp': {
				e.preventDefault();
				if (currentIndex === -1) {
					fsState.focus(visibleIds[0] ?? null);
				} else {
					const prev = visibleIds[Math.max(currentIndex - 1, 0)];
					fsState.focus(prev ?? null);
				}
				break;
			}
			case 'ArrowRight': {
				e.preventDefault();
				if (!current) break;
				const row = fsState.getFile(current);
				if (row?.type !== 'folder') break;
				if (!fsState.isExpanded(current)) {
					fsState.toggleExpand(current);
				} else {
					const children = fsState.getChildren(current);
					if (children.length > 0) fsState.focus(children[0] ?? null);
				}
				break;
			}
			case 'ArrowLeft': {
				e.preventDefault();
				if (!current) break;
				const row = fsState.getFile(current);
				if (row?.type === 'folder' && fsState.isExpanded(current)) {
					fsState.toggleExpand(current);
				} else if (row?.parentId) {
					fsState.focus(row.parentId);
				}
				break;
			}
			case 'Enter':
			case ' ': {
				e.preventDefault();
				if (!current) break;
				const row = fsState.getFile(current);
				if (row?.type === 'file') {
					fsState.selectFile(current);
				} else if (row?.type === 'folder') {
					fsState.toggleExpand(current);
				}
				break;
			}
			case 'Home': {
				e.preventDefault();
				fsState.focus(visibleIds[0] ?? null);
				break;
			}
			case 'End': {
				e.preventDefault();
				fsState.focus(visibleIds.at(-1) ?? null);
				break;
			}
			// ── Inline editing shortcuts ──────────────────────────────
			case 'n':
			case 'N': {
				e.preventDefault();
				fsState.startCreate(e.shiftKey ? 'folder' : 'file');
				break;
			}
			case 'F2': {
				e.preventDefault();
				if (current) fsState.startRename(current);
				break;
			}
			case 'Delete':
			case 'Backspace': {
				e.preventDefault();
				if (!current) break;
				const row = fsState.getFile(current);
				const name = row?.name ?? 'this item';
				const isFolder = row?.type === 'folder';
				confirmationDialog.open({
					title: `Delete ${name}?`,
					description: isFolder
						? 'This will delete the folder and all its contents. This action cannot be undone.'
						: 'This will delete the file. This action cannot be undone.',
					confirm: { text: 'Delete', variant: 'destructive' },
					onConfirm: () => fsState.deleteFile(current),
				});
				break;
			}
			default:
				return; // don't prevent default for unhandled keys
		}
	}
</script>

{#if fsState.rootChildIds.length === 0 && !fsState.inlineCreate}
	<Empty.Root class="border-0">
		<Empty.Header>
			<Empty.Title>No files yet</Empty.Title>
			<Empty.Description
				>Create files or load sample data to get started</Empty.Description
			>
		</Empty.Header>
		<Button
			variant="outline"
			size="sm"
			onclick={() => sampleDataLoader.load()}
			disabled={sampleDataLoader.seeding}
		>
			{#if sampleDataLoader.seeding}
				<Spinner class="size-3.5" />
			{:else}
				Load Sample Data
			{/if}
		</Button>
	</Empty.Root>
{:else}
	<TreeView.Root
		tabindex={0}
		aria-label="File explorer"
		onkeydown={handleKeydown}
	>
		{#each fsState.rootChildIds as childId (childId)}
			<FileTreeItem id={childId} />
		{/each}
		{#if fsState.inlineCreate?.parentId === null}
			<InlineNameInput
				icon={fsState.inlineCreate.type}
				onConfirm={fsState.confirmCreate}
				onCancel={fsState.cancelCreate}
			/>
		{/if}
	</TreeView.Root>
{/if}
