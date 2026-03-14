import {
	type Documents,
	parseSheetFromCsv,
	readEntry,
	type TableHelper,
} from '@epicenter/workspace';
import type { IFileSystem } from 'just-bash';
import { FS_ERRORS } from './errors.js';
import type { FileId } from './ids.js';
import { posixResolve } from './path.js';
import type { FileRow } from './table.js';
import { disambiguateNames } from './tree/naming.js';
import { FileTree } from './tree/tree.js';

/** Validate `fs` extends {@link IFileSystem} while preserving the full inferred type (avoids excess-property errors from `satisfies`). */
function FileSystem<T extends IFileSystem>(fs: T): T {
	return fs;
}

/**
 * Create a POSIX-like virtual filesystem backed by Yjs CRDTs.
 *
 * Thin orchestrator that delegates metadata operations to {@link FileTree}
 * and content I/O to document handles (backed by a
 * {@link Documents}). Every method applies `cwd` via
 * {@link posixResolve}, then calls the appropriate sub-service.
 *
 * The returned object satisfies the `IFileSystem` interface from `just-bash`,
 * which allows this virtual filesystem to be used as a drop-in backend for
 * shell emulation — while also exposing extra members (`index`,
 * `lookupId`, `destroy`) that aren't part of `IFileSystem`.
 *
 * **No symlinks** — `symlink`, `link`, and `readlink` always throw ENOSYS.
 * **Soft deletes** — `rm` sets `trashedAt` rather than destroying rows.
 * **No real permissions** — `chmod` is a validated no-op.
 *
 * @example
 * ```typescript
 * const ws = createWorkspace({ id: 'app', tables: { files: filesTable } });
 * const fs = createYjsFileSystem(ws.tables.files, ws.documents.files.content);
 * ```
 */
export function createYjsFileSystem(
	filesTable: TableHelper<FileRow>,
	contentDocuments: Documents<FileRow>,
	cwd: string = '/',
) {
	const tree = new FileTree(filesTable);

	return FileSystem({
		/** Reactive file-system indexes for path lookups and parent-child queries. */
		get index(): FileTree['index'] {
			return tree.index;
		},

		/**
		 * Look up the internal file ID for a resolved absolute path.
		 *
		 * Returns `undefined` if the path doesn't exist. Useful for content-layer
		 * operations that need the ID to open a document directly.
		 *
		 * @example
		 * ```typescript
		 * const fileId = fs.lookupId('/docs/readme.md');
		 * if (fileId) {
		 *   const doc = await documents.open(fileId);
		 * }
		 * ```
		 */
		lookupId(path: string): FileId | undefined {
			const abs = posixResolve(cwd, path);
			return tree.lookupId(abs);
		},

		/**
		 * Tear down reactive indexes.
		 *
		 * Content doc cleanup is handled by the workspace's documents manager
		 * destroy cascade — no need to call `destroyAll()` here.
		 */
		destroy() {
			tree.destroy();
		},

		// ═══════════════════════════════════════════════════════════════════════
		// READS — metadata only (fast, no content doc loaded)
		// ═══════════════════════════════════════════════════════════════════════

		async readdir(path) {
			const abs = posixResolve(cwd, path);
			const id = tree.resolveId(abs);
			tree.assertDirectory(id, abs);
			const activeChildren = tree.activeChildren(id);
			const displayNames = disambiguateNames(activeChildren);
			return activeChildren
				.map((row) => displayNames.get(row.id) ?? row.name)
				.sort();
		},

		async readdirWithFileTypes(path) {
			const abs = posixResolve(cwd, path);
			const id = tree.resolveId(abs);
			tree.assertDirectory(id, abs);
			const activeChildren = tree.activeChildren(id);
			const displayNames = disambiguateNames(activeChildren);
			return activeChildren
				.map((row) => ({
					name: displayNames.get(row.id) ?? row.name,
					isFile: row.type === 'file',
					isDirectory: row.type === 'folder',
					isSymbolicLink: false,
				}))
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		},

		async stat(path) {
			const abs = posixResolve(cwd, path);
			if (abs === '/') {
				return {
					isFile: false,
					isDirectory: true,
					isSymbolicLink: false,
					size: 0,
					mtime: new Date(0),
					mode: 0o755,
				};
			}
			const id = tree.resolveId(abs);
			if (id === null) throw FS_ERRORS.ENOENT(abs);
			const row = tree.getRow(id, abs);
			return {
				isFile: row.type === 'file',
				isDirectory: row.type === 'folder',
				isSymbolicLink: false,
				size: row.size,
				mtime: new Date(row.updatedAt),
				mode: row.type === 'folder' ? 0o755 : 0o644,
			};
		},

		async lstat(path) {
			return this.stat(path);
		},

		async exists(path) {
			const abs = posixResolve(cwd, path);
			return tree.exists(abs);
		},

		// ═══════════════════════════════════════════════════════════════════════
		// READS — content (may load a per-file content doc)
		// ═══════════════════════════════════════════════════════════════════════

		async readFile(path, _options?) {
			const abs = posixResolve(cwd, path);
			const id = tree.resolveId(abs);
			if (id === null) throw FS_ERRORS.ENOENT(abs);
			const row = tree.getRow(id, abs);
			if (row.type === 'folder') throw FS_ERRORS.EISDIR(abs);
			const handle = await contentDocuments.open(id);
			return handle.read();
		},

		async readFileBuffer(path) {
			const text = await this.readFile(path);
			return new TextEncoder().encode(text);
		},

		// ═══════════════════════════════════════════════════════════════════════
		// WRITES
		// ═══════════════════════════════════════════════════════════════════════

		async writeFile(path, data, _options?) {
			const abs = posixResolve(cwd, path);
			let id = tree.lookupId(abs);

			if (id) {
				const row = tree.getRow(id, abs);
				if (row.type === 'folder') throw FS_ERRORS.EISDIR(abs);
			}

			if (!id) {
				const { parentId, name } = tree.parsePath(abs);
				const textData =
					typeof data === 'string' ? data : new TextDecoder().decode(data);
				const size = new TextEncoder().encode(textData).byteLength;
				id = tree.create({ name, parentId, type: 'file', size });
			}

			const textData =
				typeof data === 'string' ? data : new TextDecoder().decode(data);
			const handle = await contentDocuments.open(id);
			const validated = readEntry(handle.timeline.currentEntry);

			let size: number;
			if (validated.mode === 'sheet') {
				handle.batch(() => {
					validated.columns.forEach((_, key) => {
						validated.columns.delete(key);
					});
					validated.rows.forEach((_, key) => {
						validated.rows.delete(key);
					});
					parseSheetFromCsv(textData, validated.columns, validated.rows);
				});
				size = new TextEncoder().encode(textData).byteLength;
			} else {
				handle.write(textData);
				size = new TextEncoder().encode(textData).byteLength;
			}
			tree.touch(id, size);
		},

		async appendFile(path, data, _options?) {
			const abs = posixResolve(cwd, path);
			const text =
				typeof data === 'string' ? data : new TextDecoder().decode(data);
			const id = tree.lookupId(abs);
			if (!id) return this.writeFile(abs, data, _options);

			const row = tree.getRow(id, abs);
			if (row.type === 'folder') throw FS_ERRORS.EISDIR(abs);

			const handle = await contentDocuments.open(id);
			const validated = readEntry(handle.timeline.currentEntry);

			if (validated.mode !== 'text') {
				await this.writeFile(path, data);
				return;
			}

			handle.batch(() => validated.content.insert(validated.content.length, text));
			const newSize = new TextEncoder().encode(validated.content.toString()).byteLength;
			tree.touch(id, newSize);
		},

		// ═══════════════════════════════════════════════════════════════════════
		// STRUCTURE — mkdir, rm, cp, mv
		// ═══════════════════════════════════════════════════════════════════════

		async mkdir(path, options?) {
			const abs = posixResolve(cwd, path);
			if (tree.exists(abs)) {
				const existingId = tree.lookupId(abs);
				if (existingId) {
					const row = tree.getRow(existingId, abs);
					if (row.type === 'file') throw FS_ERRORS.EEXIST(abs);
				}
				return;
			}

			if (options?.recursive) {
				const parts = abs.split('/').filter(Boolean);
				let currentPath = '';
				for (const part of parts) {
					currentPath += `/${part}`;
					if (tree.exists(currentPath)) {
						const existingId = tree.lookupId(currentPath);
						if (existingId) {
							const existingRow = tree.getRow(existingId, currentPath);
							if (existingRow.type === 'file')
								throw FS_ERRORS.ENOTDIR(currentPath);
						}
						continue;
					}
					const { parentId } = tree.parsePath(currentPath);
					tree.create({
						name: part,
						parentId,
						type: 'folder',
						size: 0,
					});
				}
			} else {
				const { parentId, name } = tree.parsePath(abs);
				tree.create({ name, parentId, type: 'folder', size: 0 });
			}
		},

		async rm(path, options?) {
			const abs = posixResolve(cwd, path);
			const id = tree.lookupId(abs);
			if (!id) {
				if (options?.force) return;
				throw FS_ERRORS.ENOENT(abs);
			}
			const row = tree.getRow(id, abs);

			if (row.type === 'folder' && !options?.recursive) {
				if (tree.activeChildren(id).length > 0) throw FS_ERRORS.ENOTEMPTY(abs);
			}

			// Soft-delete the row. The documents manager's table observer
			// automatically cleans up the associated content doc.
			tree.softDelete(id);

			if (row.type === 'folder' && options?.recursive) {
				for (const did of tree.descendantIds(id)) {
					tree.softDelete(did);
				}
			}
		},

		async cp(src, dest, options?) {
			const resolvedSrc = posixResolve(cwd, src);
			const resolvedDest = posixResolve(cwd, dest);
			const srcId = tree.resolveId(resolvedSrc);
			if (srcId === null) throw FS_ERRORS.EISDIR(resolvedSrc);
			const srcRow = tree.getRow(srcId, resolvedSrc);

			if (srcRow.type === 'folder') {
				if (!options?.recursive) throw FS_ERRORS.EISDIR(resolvedSrc);
				await this.mkdir(resolvedDest, { recursive: true });
				const children = await this.readdir(resolvedSrc);
				for (const child of children) {
					await this.cp(
						`${resolvedSrc}/${child}`,
						`${resolvedDest}/${child}`,
						options,
					);
				}
			} else {
				const handle = await contentDocuments.open(srcId);
				const srcText = handle.read();
				await this.writeFile(resolvedDest, srcText);
			}
		},

		async mv(src, dest) {
			const resolvedSrc = posixResolve(cwd, src);
			const resolvedDest = posixResolve(cwd, dest);
			const id = tree.resolveId(resolvedSrc);
			if (id === null) throw FS_ERRORS.EISDIR(resolvedSrc);
			tree.getRow(id, resolvedSrc);
			const { parentId: newParentId, name: newName } =
				tree.parsePath(resolvedDest);
			tree.move(id, newParentId, newName);
		},

		// ═══════════════════════════════════════════════════════════════════════
		// PATH RESOLUTION
		// ═══════════════════════════════════════════════════════════════════════

		resolvePath(base, path) {
			return posixResolve(base, path);
		},

		async realpath(path) {
			const abs = posixResolve(cwd, path);
			if (!tree.exists(abs)) throw FS_ERRORS.ENOENT(abs);
			return abs;
		},

		getAllPaths() {
			return tree.allPaths();
		},

		// ═══════════════════════════════════════════════════════════════════════
		// PERMISSIONS / TIMESTAMPS — no-op in a collaborative system
		// ═══════════════════════════════════════════════════════════════════════

		async chmod(path, _mode) {
			const abs = posixResolve(cwd, path);
			tree.resolveId(abs);
		},

		async utimes(path, _atime, mtime) {
			const abs = posixResolve(cwd, path);
			const id = tree.resolveId(abs);
			if (id === null) return;
			tree.setMtime(id, mtime);
		},

		// ═══════════════════════════════════════════════════════════════════════
		// SYMLINKS / LINKS — not supported (always throws ENOSYS)
		// ═══════════════════════════════════════════════════════════════════════

		async symlink(_target, _linkPath) {
			throw FS_ERRORS.ENOSYS('symlinks not supported');
		},

		async link(_existingPath, _newPath) {
			throw FS_ERRORS.ENOSYS('hard links not supported');
		},

		async readlink(_path) {
			throw FS_ERRORS.ENOSYS('symlinks not supported');
		},
	});
}

/** Inferred type of the virtual filesystem returned by {@link createYjsFileSystem}. */
export type YjsFileSystem = ReturnType<typeof createYjsFileSystem>;
