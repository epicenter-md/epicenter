import {
	deleteHoneycrispFolder,
	type Folder,
	type FolderId,
	type HoneycrispWorkspace,
} from '@epicenter/honeycrisp';
import type { RowLensError } from '@epicenter/workspace/sqlite';
import { searchParams } from './search-params.svelte.js';

export function createFolders({
	honeycrisp,
	refreshNotes,
}: {
	honeycrisp: HoneycrispWorkspace;
	refreshNotes(): Promise<void>;
}) {
	let rows = $state.raw<Folder[]>([]);
	let nonconforming = $state.raw<RowLensError[]>([]);
	let loadError = $state.raw<unknown>(null);
	let refreshGeneration = 0;

	async function refresh(): Promise<void> {
		const generation = ++refreshGeneration;
		try {
			const scan = await honeycrisp.tables.folders.list();
			if (generation !== refreshGeneration) return;
			rows = scan.rows;
			nonconforming = scan.nonconforming;
			loadError = null;
		} catch (cause) {
			if (generation === refreshGeneration) loadError = cause;
			throw cause;
		}
	}

	return {
		refresh,
		get(id: FolderId) {
			return rows.find((folder) => folder.id === id);
		},
		get all() {
			return rows;
		},
		get nonconforming() {
			return nonconforming;
		},
		get loadError() {
			return loadError;
		},

		async create(): Promise<{ id: FolderId }> {
			const folder = await honeycrisp.tables.folders.create({
				name: 'New Folder',
				sortOrder: rows.length,
			});
			await refresh();
			return { id: folder.id };
		},

		async rename(folderId: FolderId, name: string): Promise<void> {
			const result = await honeycrisp.tables.folders.update(folderId, { name });
			if (result.error !== null) throw result.error;
			await refresh();
		},

		async delete(folderId: FolderId): Promise<void> {
			await deleteHoneycrispFolder(honeycrisp, folderId);
			await Promise.all([refresh(), refreshNotes()]);
			if (searchParams.folder === folderId) {
				searchParams.update({ folder: null, note: null });
			}
		},
	};
}
