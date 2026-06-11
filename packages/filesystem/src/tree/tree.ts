import type { Table } from '@epicenter/workspace';
import type * as Y from 'yjs';
import { FS_ERRORS } from '../errors.js';
import type { FileId } from '../ids.js';
import { generateFileId } from '../ids.js';
import { posixResolve } from '../path.js';
import type { FileRow } from '../table.js';
import { assertUniqueName, validateName } from './naming.js';
import { attachFileSystemIndex } from './path-index.js';

/**
 * Create metadata tree operations for a POSIX-like virtual filesystem.
 *
 * Owns the files table and the derived path/children indexes.
 * All methods work with absolute paths (never sees `cwd`).
 * Has no knowledge of file content: only structure and metadata.
 *
 * Teardown is hooked to `ydoc.once('destroy', ...)` via the underlying
 * index. Callers do not call a dispose method.
 */
export function attachFileTree(ydoc: Y.Doc, filesTable: Table<FileRow>) {
	const index = attachFileSystemIndex(ydoc, filesTable);

	return {
		/** Reactive file-system indexes for path lookups and parent-child queries. */
		index,

		// ═════════════════════════════════════════════════════════════════
		// LOOKUPS
		// ═════════════════════════════════════════════════════════════════

		/**
		 * Look up the `FileId` for a resolved absolute path.
		 * Returns `null` for the root path `/` (which has no table row).
		 *
		 * @throws ENOENT if the path doesn't exist in the index.
		 */
		resolveId(path: string): FileId | null {
			if (path === '/') return null;
			const id = index.getIdByPath(path);
			if (!id) throw FS_ERRORS.ENOENT(path);
			return id;
		},

		/**
		 * Look up the `FileId` for a path without throwing.
		 * Returns `undefined` if the path doesn't exist.
		 */
		lookupId(path: string): FileId | undefined {
			return index.getIdByPath(path);
		},

		/**
		 * Fetch the `FileRow` for a given ID, throwing ENOENT if it's been
		 * deleted or is otherwise invalid.
		 */
		getRow(id: FileId, path: string): FileRow {
			const { data: row, error } = filesTable.get(id);
			if (error) throw FS_ERRORS.ENOENT(path); // invalid row → treat as missing
			if (row === null) throw FS_ERRORS.ENOENT(path);
			return row;
		},

		/**
		 * Split an absolute path into its parent ID and base name.
		 *
		 * @throws ENOENT if the parent directory doesn't exist.
		 */
		parsePath(path: string): { parentId: FileId | null; name: string } {
			const normalized = posixResolve('/', path);
			const lastSlash = normalized.lastIndexOf('/');
			const name = normalized.substring(lastSlash + 1);
			const parentPath = normalized.substring(0, lastSlash) || '/';
			if (parentPath === '/') return { parentId: null, name };
			const parentId = index.getIdByPath(parentPath);
			if (!parentId) throw FS_ERRORS.ENOENT(parentPath);
			return { parentId, name };
		},

		/** Assert that a resolved ID points to a directory (root `/` always passes). */
		assertDirectory(id: FileId | null, path: string): void {
			if (id === null) return;
			const row = this.getRow(id, path);
			if (row.type !== 'folder') throw FS_ERRORS.ENOTDIR(path);
		},

		// ═════════════════════════════════════════════════════════════════
		// QUERIES
		// ═════════════════════════════════════════════════════════════════

		/**
		 * Get valid child rows of a parent (null = root).
		 *
		 * The index only contains active (non-trashed) child IDs, so the
		 * only check needed is row validity (structural integrity).
		 */
		activeChildren(parentId: FileId | null): FileRow[] {
			const ids = index.getChildIds(parentId);
			const rows: FileRow[] = [];
			for (const cid of ids) {
				const { data: row, error } = filesTable.get(cid);
				if (error) continue; // skip invalid rows
				if (row === null) continue;
				rows.push(row);
			}
			return rows;
		},

		/**
		 * Collect all active descendant IDs of a folder (recursive).
		 * Returns a flat array of IDs: the caller decides what to do with them.
		 */
		descendantIds(parentId: FileId): FileId[] {
			const result: FileId[] = [];
			const children = index.getChildIds(parentId);
			for (const cid of children) {
				const { data: row, error } = filesTable.get(cid);
				if (error) continue;
				if (row === null) continue;
				result.push(cid);
				if (row.type === 'folder') {
					result.push(...this.descendantIds(cid));
				}
			}
			return result;
		},

		/** Check whether a path exists in the index (root `/` always exists). */
		exists(path: string): boolean {
			return path === '/' || index.hasPath(path);
		},

		/** Get all indexed paths. */
		allPaths(): string[] {
			return index.allPaths();
		},

		// ═════════════════════════════════════════════════════════════════
		// MUTATIONS
		// ═════════════════════════════════════════════════════════════════

		/**
		 * Create a new file or folder. Validates name and uniqueness.
		 *
		 * @returns The new FileId.
		 */
		create({
			name,
			parentId,
			type,
			size,
		}: {
			name: string;
			parentId: FileId | null;
			type: 'file' | 'folder';
			size: number;
		}): FileId {
			validateName(name);
			assertUniqueName(filesTable, index.getChildIds(parentId), name);
			const id = generateFileId();
			filesTable.set({
				id,
				name,
				parentId,
				type,
				size,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				trashedAt: null,
			});
			return id;
		},

		/** Soft-delete a file or folder by setting `trashedAt`. */
		softDelete(id: FileId): void {
			filesTable.update(id, { trashedAt: Date.now() });
		},

		/** Move/rename a file or folder. Validates name and uniqueness. */
		move(id: FileId, newParentId: FileId | null, newName: string): void {
			validateName(newName);
			assertUniqueName(filesTable, index.getChildIds(newParentId), newName, id);
			filesTable.update(id, {
				name: newName,
				parentId: newParentId,
				updatedAt: Date.now(),
			});
		},

		/** Update size and `updatedAt` after a content write. */
		touch(id: FileId, size: number): void {
			filesTable.update(id, { size, updatedAt: Date.now() });
		},

		/** Update `updatedAt` only (for utimes). */
		setMtime(id: FileId, mtime: Date): void {
			filesTable.update(id, { updatedAt: mtime.getTime() });
		},
	};
}

/** Inferred type of the file tree returned by {@link attachFileTree}. */
export type FileTree = ReturnType<typeof attachFileTree>;
