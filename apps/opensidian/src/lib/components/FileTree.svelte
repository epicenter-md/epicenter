<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import * as Empty from '@epicenter/ui/empty';
	import * as TreeView from '@epicenter/ui/tree-view';
	import { fsState } from '$lib/fs/fs-state.svelte';
	import FileTreeItem from './FileTreeItem.svelte';

	/**
	 * Flat list of visible item IDs in visual order.
	 * Respects folder expansion state—collapsed folders hide their descendants.
	 */
	const visibleIds = $derived.by(() => {
		void fsState.version;
		const ids: FileId[] = [];
		function walk(parentId: FileId | null) {
			for (const childId of fsState.getChildIds(parentId)) {
				const row = fsState.getRow(childId);
				if (!row) continue;
				ids.push(childId);
				if (row.type === 'folder' && fsState.expandedIds.has(childId)) {
					walk(childId);
				}
			}
		}
		walk(null);
		return ids;
	});

	function handleKeydown(e: KeyboardEvent) {
		const current = fsState.focusedId;
		const currentIndex = current ? visibleIds.indexOf(current) : -1;

		switch (e.key) {
			case 'ArrowDown': {
				e.preventDefault();
				if (currentIndex === -1) {
					fsState.actions.focus(visibleIds[0] ?? null);
				} else {
					const next =
						visibleIds[Math.min(currentIndex + 1, visibleIds.length - 1)];
					fsState.actions.focus(next ?? null);
				}
				break;
			}
			case 'ArrowUp': {
				e.preventDefault();
				if (currentIndex === -1) {
					fsState.actions.focus(visibleIds[0] ?? null);
				} else {
					const prev = visibleIds[Math.max(currentIndex - 1, 0)];
					fsState.actions.focus(prev ?? null);
				}
				break;
			}
			case 'ArrowRight': {
				e.preventDefault();
				if (!current) break;
				const row = fsState.getRow(current);
				if (row?.type !== 'folder') break;
				if (!fsState.expandedIds.has(current)) {
					fsState.actions.toggleExpand(current);
				} else {
					const children = fsState.getChildIds(current);
					if (children.length > 0) fsState.actions.focus(children[0]!);
				}
				break;
			}
			case 'ArrowLeft': {
				e.preventDefault();
				if (!current) break;
				const row = fsState.getRow(current);
				if (row?.type === 'folder' && fsState.expandedIds.has(current)) {
					fsState.actions.toggleExpand(current);
				} else if (row?.parentId) {
					fsState.actions.focus(row.parentId);
				}
				break;
			}
			case 'Enter':
			case ' ': {
				e.preventDefault();
				if (!current) break;
				const row = fsState.getRow(current);
				if (row?.type === 'file') {
					fsState.actions.selectFile(current);
				} else if (row?.type === 'folder') {
					fsState.actions.toggleExpand(current);
				}
				break;
			}
			case 'Home': {
				e.preventDefault();
				fsState.actions.focus(visibleIds[0] ?? null);
				break;
			}
			case 'End': {
				e.preventDefault();
				fsState.actions.focus(visibleIds.at(-1) ?? null);
				break;
			}
			default:
				return; // don't prevent default for unhandled keys
		}
	}
</script>

{#if fsState.rootChildIds.length === 0}
	<Empty.Root class="border-0">
		<Empty.Header>
			<Empty.Title>No files yet</Empty.Title>
			<Empty.Description
				>Use the toolbar to create files and folders</Empty.Description
			>
		</Empty.Header>
	</Empty.Root>
{:else}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<TreeView.Root tabindex={0} onkeydown={handleKeydown}>
		{#each fsState.rootChildIds as childId (childId)}
			<FileTreeItem id={childId} />
		{/each}
	</TreeView.Root>
{/if}
