import {
	deleteHoneycrispFolder,
	type FolderId,
	type HoneycrispData,
} from '@epicenter/honeycrisp';
import type { ReactiveWorkspace } from '@epicenter/svelte';
import { navigation } from './navigation.svelte.js';

/**
 * Honeycrisp's own folder concepts, over the reactive `folders` table.
 *
 * Same shape as `createNotes` and for the same reason: the reactive table
 * answers the "what rows are here" question, so what remains is domain: the
 * new-folder defaults, renaming, and the delete that re-parents notes and
 * cleans up the URL.
 */
export function createFolders({
	workspace,
}: {
	workspace: ReactiveWorkspace<HoneycrispData>;
}) {
	const table = workspace.tables.folders;

	// Name order, and nothing durable about order at all: it is deterministic
	// on every device without a schema field, and every surface that lists
	// folders (sidebar, move-to menu, palette) wants the same answer.
	const all = $derived(
		table.rows.toSorted((a, b) => a.name.localeCompare(b.name)),
	);

	return {
		get(id: FolderId) {
			return table.rows.find((folder) => folder.id === id);
		},
		get all() {
			return all;
		},
		get nonconforming() {
			return table.nonconforming;
		},

		create(): { id: FolderId } {
			const { data, error } = table.create({ name: 'New Folder' });
			if (error !== null) throw error;
			return { id: data.id };
		},

		rename(folderId: FolderId, name: string): void {
			const { error } = table.update(folderId, { name });
			if (error !== null) throw error;
		},

		delete(folderId: FolderId): void {
			// Re-parents this folder's notes and then removes it. Both tables
			// invalidate on their own, so nothing has to be told to re-read.
			deleteHoneycrispFolder(workspace, folderId);
			navigation.folderRemoved(folderId);
		},
	};
}
