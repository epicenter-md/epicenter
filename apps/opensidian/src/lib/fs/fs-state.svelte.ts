import {
	createSqliteIndex,
	createYjsFileSystem,
	type FileId,
	type FileRow,
	filesTable,
} from '@epicenter/filesystem';
import { createWorkspace } from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { SvelteSet } from 'svelte/reactivity';
import { toast } from 'svelte-sonner';

/**
 * Reactive filesystem state singleton.
 *
 * Follows the tab-manager pattern: factory function creates all state,
 * exports a single const. Components import and read directly.
 *
 * Reactivity bridge: `FileSystemIndex` rebuilds itself on every table
 * mutation via its own observer. We layer a `version` counter ($state)
 * that bumps on every mutation (coalesced via rAF), which triggers
 * `$derived` recomputations that re-read from the already-updated index.
 *
 * @example
 * ```svelte
 * <script>
 *   import { fsState } from '$lib/fs/fs-state.svelte';
 *   const children = $derived(fsState.rootChildIds);
 * </script>
 * ```
 */
function createFsState() {
	const ws = createWorkspace({
		id: 'opensidian',
		tables: { files: filesTable },
	}).withExtension('persistence', indexeddbPersistence)
		.withWorkspaceExtension('sqliteIndex', createSqliteIndex());
	const fs = createYjsFileSystem(ws.tables.files, ws.documents.files.content);
	const documents = ws.documents.files.content;

	// ── Reactive state ────────────────────────────────────────────────
	let version = $state(0);
	let activeFileId = $state<FileId | null>(null);
	let openFileIds = $state<FileId[]>([]);
	const expandedIds = new SvelteSet<FileId>();
	let focusedId = $state<FileId | null>(null);

	// ── rAF-coalesced observer ────────────────────────────────────────
	let pendingBump = false;
	const unobserve = ws.tables.files.observe(() => {
		if (!pendingBump) {
			pendingBump = true;
			requestAnimationFrame(() => {
				version++;
				pendingBump = false;
			});
		}
	});

	// ── Derived state ─────────────────────────────────────────────────

	/** Root-level child IDs — recomputes when version bumps. */
	const rootChildIds = $derived.by(() => {
		void version;
		return fs.index.getChildIds(null);
	});

	/** Full FileRow for the active file, or null. */
	const selectedNode = $derived.by(() => {
		void version;
		if (!activeFileId) return null;
		const result = ws.tables.files.get(activeFileId);
		return result.status === 'valid' ? result.row : null;
	});

	/**
	 * Path string for the active file (e.g. "/docs/api.md"), or null.
	 * Computed by searching the index's path map.
	 */
	const selectedPath = $derived.by(() => {
		void version;
		if (!activeFileId) return null;
		for (const p of fs.index.allPaths()) {
			if (fs.index.getIdByPath(p) === activeFileId) return p;
		}
		return null;
	});

	const state = {
		// ── Read-only getters ───────────────────────────────────────
		get version() {
			return version;
		},
		get activeFileId() {
			return activeFileId;
		},
		get openFileIds() {
			return openFileIds;
		},
		get rootChildIds() {
			return rootChildIds;
		},
		get selectedNode() {
			return selectedNode;
		},
		get selectedPath() {
			return selectedPath;
		},
		get focusedId() {
			return focusedId;
		},

		expandedIds,
		fs,
		documents,
		sqliteIndex: ws.extensions.sqliteIndex,

		/**
		 * Get child FileIds of a folder. Reads from FileSystemIndex.
		 * Must be called in a reactive context to track `version`.
		 */
		getChildIds(parentId: FileId | null) {
			void version;
			return fs.index.getChildIds(parentId);
		},

		/**
		 * Get the FileRow for a given ID.
		 * Returns null if the row is deleted/invalid.
		 */
		getRow(id: FileId): FileRow | null {
			void version;
			const result = ws.tables.files.get(id);
			return result.status === 'valid' ? result.row : null;
		},

		/**
		 * Find the path for a file ID by searching the index.
		 * Returns null if not found (deleted/trashed).
		 */
		getPathForId(id: FileId): string | null {
			void version;
			for (const p of fs.index.allPaths()) {
				if (fs.index.getIdByPath(p) === id) return p;
			}
			return null;
		},

		actions: {
			selectFile(id: FileId) {
				activeFileId = id;
				if (!openFileIds.includes(id)) {
					openFileIds = [...openFileIds, id];
				}
			},

			closeFile(id: FileId) {
				openFileIds = openFileIds.filter((f) => f !== id);
				if (activeFileId === id) {
					activeFileId = openFileIds.at(-1) ?? null;
				}
			},

			toggleExpand(id: FileId) {
				if (expandedIds.has(id)) expandedIds.delete(id);
				else expandedIds.add(id);
			},

			focus(id: FileId | null) {
				focusedId = id;
			},

			async createFile(parentId: FileId | null, name: string) {
				try {
					const parentPath = parentId
						? (state.getPathForId(parentId) ?? '/')
						: '/';
					const path =
						parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
					await fs.writeFile(path, '');
					toast.success(`Created ${path}`);
				} catch (err) {
					toast.error(
						err instanceof Error ? err.message : 'Failed to create file',
					);
					console.error(err);
				}
			},

			async createFolder(parentId: FileId | null, name: string) {
				try {
					const parentPath = parentId
						? (state.getPathForId(parentId) ?? '/')
						: '/';
					const path =
						parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
					await fs.mkdir(path);
					if (parentId) expandedIds.add(parentId);
					toast.success(`Created ${path}/`);
				} catch (err) {
					toast.error(
						err instanceof Error ? err.message : 'Failed to create folder',
					);
					console.error(err);
				}
			},

			async deleteFile(id: FileId) {
				try {
					const path = state.getPathForId(id);
					if (!path) return;
					await fs.rm(path, { recursive: true });
					if (activeFileId === id) activeFileId = null;
					openFileIds = openFileIds.filter((f) => f !== id);
					toast.success(`Deleted ${path}`);
				} catch (err) {
					toast.error(err instanceof Error ? err.message : 'Failed to delete');
					console.error(err);
				}
			},

			async rename(id: FileId, newName: string) {
				try {
					const oldPath = state.getPathForId(id);
					if (!oldPath) return;
					const parentPath =
						oldPath.substring(0, oldPath.lastIndexOf('/')) || '/';
					const newPath =
						parentPath === '/' ? `/${newName}` : `${parentPath}/${newName}`;
					await fs.mv(oldPath, newPath);
					toast.success(`Renamed to ${newName}`);
				} catch (err) {
					toast.error(err instanceof Error ? err.message : 'Failed to rename');
					console.error(err);
				}
			},

			/**
			 * Read file content as string.
			 *
			 * Opens the per-file content Y.Doc and reads from the timeline.
			 */
			async readContent(id: FileId): Promise<string | null> {
				try {
					const handle = await documents.open(id);
					return handle.read();
				} catch (err) {
					console.error('Failed to read content:', err);
					return null;
				}
			},

			/**
			 * Write file content as string.
			 *
			 * Opens the per-file content Y.Doc and writes to the timeline.
			 * The documents manager's `onUpdate` callback bumps `updatedAt` on the file row.
			 */
			async writeContent(id: FileId, data: string): Promise<void> {
				try {
					const handle = await documents.open(id);
					handle.write(data);
				} catch (err) {
					toast.error(
						err instanceof Error ? err.message : 'Failed to save file',
					);
					console.error(err);
				}
			},
		},

		/** Cleanup — call from +layout.svelte onDestroy if needed. */
		async destroy() {
			unobserve();
			fs.index.destroy();
			await fs.destroy();
		},
	};

	return state;
}

export const fsState = createFsState();

// Expose on window for dev console access
// Usage: await fsState.sqliteIndex.search('hello')
//        await fsState.sqliteIndex.client.execute('SELECT * FROM files')
if (typeof window !== 'undefined') {
	(window as unknown as Record<string, unknown>).fsState = fsState;
}
