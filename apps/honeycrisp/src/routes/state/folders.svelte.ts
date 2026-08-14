import type { NonconformingRow } from '@epicenter/data';
import {
	deleteHoneycrispFolder,
	type Folder,
	type FolderId,
	type HoneycrispData,
} from '@epicenter/honeycrisp';
import { searchParams } from './search-params.svelte.js';

/**
 * Honeycrisp's folders, read straight out of the store.
 *
 * Same shape as `createNotes` and for the same reason: the store says which
 * rows moved, so nothing here refreshes and nothing awaits a read.
 */
export function createFolders({ db }: { db: HoneycrispData }) {
	let rows = $state.raw<Folder[]>([]);
	let nonconforming = $state.raw<NonconformingRow[]>([]);

	function read(): void {
		// `list` cannot fail: a store that cannot serve reads throws
		// `StoreUnusableError`, which surfaces at the app's error boundary.
		const listed = db.tables.folders.list();
		rows = listed.rows;
		nonconforming = listed.nonconforming;
	}

	read();
	const stop = db.tables.folders.subscribe(read);

	return {
		[Symbol.dispose]: stop,
		get(id: FolderId) {
			return rows.find((folder) => folder.id === id);
		},
		get all() {
			return rows;
		},
		get nonconforming() {
			return nonconforming;
		},

		create(): { id: FolderId } {
			const { data, error } = db.tables.folders.create({
				name: 'New Folder',
				sortOrder: rows.length,
			});
			if (error !== null) throw error;
			return { id: data.id };
		},

		rename(folderId: FolderId, name: string): void {
			const { error } = db.tables.folders.update(folderId, { name });
			if (error !== null) throw error;
		},

		delete(folderId: FolderId): void {
			// Re-parents this folder's notes and then removes it. Both tables
			// invalidate on their own, so nothing has to be told to re-read.
			deleteHoneycrispFolder(db, folderId);
			if (searchParams.folder === folderId) {
				searchParams.update({ folder: null, note: null });
			}
		},
	};
}
