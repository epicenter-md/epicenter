import type { FileId, FileRow } from '@epicenter/filesystem';
import { fromTable } from '@epicenter/svelte';
import { toast } from '@epicenter/ui/sonner';
import { SvelteSet } from 'svelte/reactivity';
import { fs, workspace } from '$lib/client';

/**
 * Interaction mode discriminated union.
 *
 * Only one interaction can be active at a time. Setting any mode
 * implicitly cancels the previous one—impossible states are unrepresentable.
 */
type InteractionMode =
	| { type: 'idle' }
	| { type: 'renaming'; targetId: FileId }
	| { type: 'creating'; parentId: FileId | null; fileType: 'file' | 'folder' };

/**
 * Reactive filesystem state singleton.
 *
 * Follows the tab-manager pattern: factory function creates all state,
 * exports a single const. Components import and read directly.
 *
 * Reactivity: `fromTable()` provides a reactive `SvelteMap` that updates
 * granularly per-row. `childrenOf` derives tree structure eagerly (O(n)
 * iteration on any row change—acceptable for <5000 files). Paths are
 * computed lazily via `computePath()`—only the accessed file's ancestor
 * chain is tracked, so `selected` and `PathBreadcrumb` stay fine-grained.
 *
 * @example
 * ```svelte
 * <script>
 *   import { fsState } from '$lib/state/fs-state.svelte';
 *   const children = fsState.rootChildIds;
 * </script>
 * ```
 */
function createFsState() {
	// ── Reactive source ──────────────────────────────────────────────
	const filesMap = fromTable(workspace.tables.files);

	// ── Reactive state ───────────────────────────────────────────────
	let activeFileId = $state<FileId | null>(null);
	const openFileIds = new SvelteSet<FileId>();
	const expandedIds = new SvelteSet<FileId>();
	let focusedId = $state<FileId | null>(null);

	// ── Interaction mode ─────────────────────────────────────────────
	// A single discriminated union prevents conflicting modes
	// (e.g. can't rename and create at the same time).
	let interactionMode = $state<InteractionMode>({ type: 'idle' });

	// ── Context menu hover persistence ───────────────────────────────
	// Tracks which tree item's context menu is currently open so the
	// item stays visually highlighted while the mouse is on the menu.
	let contextMenuTargetId = $state<FileId | null>(null);

	// ── Derived tree structure ───────────────────────────────────────
	//
	// childrenOf iterates the full filesMap (creating an all-key dependency),
	// so it recomputes on ANY row change—even non-structural edits like
	// updatedAt bumps. At O(n) Map iteration for <5000 files this is <1ms,
	// an intentional trade-off over the complexity of structural-only tracking.

	/** Parent→children mapping. Groups non-trashed file IDs by parentId. */
	const childrenOf = $derived.by(() => {
		const map = new Map<FileId | null, FileId[]>();
		for (const [id, row] of filesMap) {
			if (row.trashedAt !== null) continue;
			const siblings = map.get(row.parentId) ?? [];
			siblings.push(id);
			map.set(row.parentId, siblings);
		}
		return map;
	});

	// ── Lazy path computation ────────────────────────────────────────

	/**
	 * Build the full POSIX path for a file by walking up the ancestor chain.
	 *
	 * O(depth) per call—typically 3–5 `filesMap.get()` lookups. In a reactive
	 * context (`$derived`), this creates fine-grained dependencies on only the
	 * accessed file's ancestors, not every row in the tree. In an imperative
	 * context (action methods), it's a plain lookup with no reactive cost.
	 *
	 * Replaces the previous eager `pathIndex` derived which rebuilt all paths
	 * (O(n) string concatenation) on any row change.
	 *
	 * @example
	 * ```typescript
	 * // In $derived — tracks only activeFile + ancestors
	 * const path = $derived(computePath(activeFileId));
	 *
	 * // In action — plain lookup, no reactive tracking
	 * const oldPath = computePath(id);
	 * ```
	 */
	function computePath(id: FileId): string | null {
		const row = filesMap.get(id);
		if (!row || row.trashedAt !== null) return null;

		const parts: string[] = [row.name];
		let parentId = row.parentId;

		while (parentId !== null) {
			const parent = filesMap.get(parentId);
			if (!parent || parent.trashedAt !== null) return null;
			parts.unshift(parent.name);
			parentId = parent.parentId;
		}

		return '/' + parts.join('/');
	}

	/** Root-level child IDs. */
	const rootChildIds = $derived(childrenOf.get(null) ?? []);

	/**
	 * Active file's row data.
	 *
	 * Fine-grained: only tracks the active file's row via `filesMap.get()`.
	 * Unrelated row changes don't trigger recomputation.
	 */
	const selectedNode = $derived(
		activeFileId ? (filesMap.get(activeFileId) ?? null) : null,
	);

	/**
	 * Active file's full POSIX path.
	 *
	 * Fine-grained: only tracks the active file's name and ancestor chain
	 * (via `computePath`). A `size` or `updatedAt` change on a sibling file
	 * won't trigger recomputation—only name/ancestry changes matter.
	 */
	const selectedPath = $derived(
		activeFileId ? computePath(activeFileId) : null,
	);

	// ── Derived from interaction mode ────────────────────────────────
	// Stable public API over the internal union. Components read these
	// without coupling to InteractionMode's shape.

	const renamingId = $derived(
		interactionMode.type === 'renaming' ? interactionMode.targetId : null,
	);

	const inlineCreate = $derived(
		interactionMode.type === 'creating'
			? { parentId: interactionMode.parentId, type: interactionMode.fileType }
			: null,
	);

	// ── Private helpers ───────────────────────────────────────────────

	/**
	 * Wrap an async operation with error toast handling.
	 * The callback contains all logic including success toasts.
	 * On error, shows the error's own message or the fallback.
	 */
	async function withErrorToast(
		fn: () => Promise<void>,
		fallbackMessage: string,
	) {
		try {
			await fn();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : fallbackMessage);
			console.error(err);
		}
	}

	const state = {
		// ── Read-only getters ───────────────────────────────────────
		get activeFileId() {
			return activeFileId;
		},
		get openFileIds() {
			return openFileIds as ReadonlySet<FileId>;
		},
		get hasOpenFiles() {
			return openFileIds.size > 0;
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
		get inlineCreate() {
			return inlineCreate;
		},
		get renamingId() {
			return renamingId;
		},
		get contextMenuTargetId() {
			return contextMenuTargetId;
		},

		/** Whether a folder is expanded in the tree view. */
		isExpanded(id: FileId) {
			return expandedIds.has(id);
		},

		/** Expand a folder in the tree view (no-op if already expanded). */
		expand(id: FileId) {
			expandedIds.add(id);
		},

		/** Collapse a folder in the tree view (no-op if already collapsed). */
		collapse(id: FileId) {
			expandedIds.delete(id);
		},

		/** Get child FileIds of a folder. Reactive via `childrenOf` derived. */
		getChildren(parentId: FileId | null) {
			return childrenOf.get(parentId) ?? [];
		},

		/**
		 * Get the FileRow for a given ID.
		 * Returns null if the row is deleted/invalid.
		 */
		getFile(id: FileId): FileRow | null {
			return filesMap.get(id) ?? null;
		},

		/**
		 * Build the full POSIX path for a file by walking up its ancestor chain.
		 *
		 * In reactive contexts (e.g., inside `$derived`), creates fine-grained
		 * dependencies on only the accessed file's ancestors. In imperative
		 * contexts (action methods), it's a plain O(depth) lookup.
		 *
		 * @returns The full path (e.g., `/docs/api/reference.md`) or null if trashed/deleted.
		 */
		getPath(id: FileId): string | null {
			return computePath(id);
		},

		/**
		 * Walk the file tree recursively, calling `visitor` for each node.
		 *
		 * The visitor receives a file ID and its row, and returns an object:
		 * - `collect`: if present, the value is added to the result array
		 * - `descend`: if true, recurse into children (only meaningful for folders)
		 *
		 * @example
		 * ```typescript
		 * // Collect all visible IDs (respecting folder expansion)
		 * const visibleIds = fsState.walkTree((id, row) => ({
		 *   collect: id,
		 *   descend: row.type === 'folder' && fsState.isExpanded(id),
		 * }));
		 *
		 * // Collect only files with metadata
		 * const allFiles = fsState.walkTree((id, row) => {
		 *   if (row.type === 'file') return { collect: { id, name: row.name }, descend: false };
		 *   return { descend: true };
		 * });
		 * ```
		 */
		walkTree<T>(
			visitor: (id: FileId, row: FileRow) => { collect?: T; descend: boolean },
			parentId: FileId | null = null,
		): T[] {
			const results: T[] = [];
			function walk(pid: FileId | null) {
				for (const childId of childrenOf.get(pid) ?? []) {
					const row = filesMap.get(childId);
					if (!row || row.trashedAt !== null) continue;
					const { collect, descend } = visitor(childId, row);
					if (collect !== undefined) results.push(collect);
					if (descend) walk(childId);
				}
			}
			walk(parentId);
			return results;
		},

		// ── Inline editing ───────────────────────────────────────────

		/**
		 * Begin inline creation. Shows an input in the tree at the target location.
		 * If a folder is focused, creates inside it. If a file is focused, creates as sibling.
		 * If nothing is focused, creates at root.
		 */
		startCreate(fileType: 'file' | 'folder') {
			const focused = focusedId ?? activeFileId;
			if (!focused) {
				interactionMode = { type: 'creating', parentId: null, fileType };
				return;
			}
			const row = state.getFile(focused);
			if (row?.type === 'folder') {
				expandedIds.add(focused);
				interactionMode = { type: 'creating', parentId: focused, fileType };
			} else if (row?.parentId) {
				interactionMode = {
					type: 'creating',
					parentId: row.parentId,
					fileType,
				};
			} else {
				interactionMode = { type: 'creating', parentId: null, fileType };
			}
		},

		cancelCreate() {
			interactionMode = { type: 'idle' };
		},

		async confirmCreate(name: string) {
			if (!name.trim() || interactionMode.type !== 'creating') return;
			const { parentId, fileType } = interactionMode;
			interactionMode = { type: 'idle' };
			if (fileType === 'file') {
				await state.createFile(parentId, name.trim());
			} else {
				await state.createFolder(parentId, name.trim());
			}
		},

		startRename(id: FileId) {
			interactionMode = { type: 'renaming', targetId: id };
		},

		cancelRename() {
			interactionMode = { type: 'idle' };
		},

		async confirmRename(newName: string) {
			if (!newName.trim() || interactionMode.type !== 'renaming') return;
			const id = interactionMode.targetId;
			interactionMode = { type: 'idle' };
			await state.rename(id, newName.trim());
		},

		// ── Context menu ─────────────────────────────────────────────

		setContextMenuTarget(id: FileId | null) {
			contextMenuTargetId = id;
		},

		// ── Actions ──────────────────────────────────────────────────

		selectFile(id: FileId) {
			activeFileId = id;
			openFileIds.add(id);
		},

		closeFile(id: FileId) {
			openFileIds.delete(id);
			if (activeFileId === id) {
				activeFileId = [...openFileIds].at(-1) ?? null;
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
			await withErrorToast(async () => {
				const parentPath = parentId ? (state.getPath(parentId) ?? '/') : '/';
				const path = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
				await fs.writeFile(path, '');
				toast.success(`Created ${path}`);
			}, 'Failed to create file');
		},

		async createFolder(parentId: FileId | null, name: string) {
			await withErrorToast(async () => {
				const parentPath = parentId ? (state.getPath(parentId) ?? '/') : '/';
				const path = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
				await fs.mkdir(path);
				if (parentId) expandedIds.add(parentId);
				toast.success(`Created ${path}/`);
			}, 'Failed to create folder');
		},

		async deleteFile(id: FileId) {
			await withErrorToast(async () => {
				const path = state.getPath(id);
				if (!path) return;
				await fs.rm(path, { recursive: true });
				if (activeFileId === id) activeFileId = null;
				openFileIds.delete(id);
				toast.success(`Deleted ${path}`);
			}, 'Failed to delete');
		},

		async rename(id: FileId, newName: string) {
			await withErrorToast(async () => {
				const oldPath = state.getPath(id);
				if (!oldPath) return;
				const parentPath =
					oldPath.substring(0, oldPath.lastIndexOf('/')) || '/';
				const newPath =
					parentPath === '/' ? `/${newName}` : `${parentPath}/${newName}`;
				await fs.mv(oldPath, newPath);
				toast.success(`Renamed to ${newName}`);
			}, 'Failed to rename');
		},

		/** Cleanup — call from +layout.svelte onDestroy if needed. */
		async dispose() {
			filesMap.destroy();
			fs.index.dispose();
			fs.dispose();
		},
	};

	return state;
}

export const fsState = createFsState();
