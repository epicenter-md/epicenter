/**
 * Reactive folder state for Honeycrisp.
 *
 * Manages folder CRUD operations and the reactive folder list. Backed by
 * a Y.Doc CRDT table, so folders sync across devices. Uses a factory
 * function pattern to encapsulate `$state`.
 *
 * Observers are registered once during factory construction and never
 * cleaned up (SPA lifetime).
 *
 * @example
 * ```svelte
 * <script>
 *   import { foldersState } from '$lib/state';
 * </script>
 *
 * {#each foldersState.folders as folder (folder.id)}
 *   <p>{folder.name}</p>
 * {/each}
 * <button onclick={() => foldersState.createFolder()}>New Folder</button>
 * ```
 */

import { fromTable } from '@epicenter/svelte';
import { generateId } from '@epicenter/workspace';
import { workspace } from '$lib/client';
import type { FolderId } from '$lib/workspace';

function createFoldersState() {
	// ─── Reactive State ──────────────────────────────────────────────────

	const foldersMap = fromTable(workspace.tables.folders);

	const folders = $derived(foldersMap.values().toArray());

	// ─── Public API ──────────────────────────────────────────────────────

	return {
		get folders() {
			return folders;
		},

		/**
		 * Create a new folder with the default name "New Folder".
		 *
		 * The folder is added to the end of the folder list and can be renamed
		 * immediately. Use this when the user clicks "New Folder" in the sidebar.
		 *
		 * @example
		 * ```typescript
		 * foldersState.createFolder();
		 * // Folder appears in sidebar with name "New Folder"
		 * ```
		 */
		createFolder() {
			const id = generateId() as string as FolderId;
			workspace.tables.folders.set({
				id,
				name: 'New Folder',
				sortOrder: foldersMap.size,
				_v: 1,
			});
		},

		/**
		 * Rename an existing folder.
		 *
		 * Updates the folder name in the sidebar and all references. The folder
		 * must exist; if it doesn't, the update is silently ignored.
		 *
		 * @example
		 * ```typescript
		 * foldersState.renameFolder(folderId, 'Work');
		 * ```
		 */
		renameFolder(folderId: FolderId, name: string) {
			workspace.tables.folders.update(folderId, { name });
		},

		/**
		 * Delete a folder and move all its notes to unfiled.
		 *
		 * The folder is removed from the sidebar. All notes that were in this
		 * folder are moved to the unfiled section (folderId set to undefined).
		 * If the deleted folder was selected, the selection is cleared.
		 *
		 * @example
		 * ```typescript
		 * foldersState.deleteFolder(folderId);
		 * // Folder disappears from sidebar, its notes move to "All Notes"
		 * ```
		 */
		deleteFolder(folderId: FolderId) {
			workspace.actions.folders.delete({ folderId });
		},
	};
}

export const foldersState = createFoldersState();
