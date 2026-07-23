import type { FileId, FileRow } from '@epicenter/filesystem';
import { fromTable } from '@epicenter/svelte';
import { toast } from '@epicenter/ui/sonner';
import type { OpensidianBrowser } from 'opensidian/browser';
import { SvelteSet } from 'svelte/reactivity';
import { extractErrorMessage } from 'wellcrafted/error';
import { searchParams } from '$lib/search-params.svelte';

/**
 * Interaction mode discriminated union.
 *
 * Only one interaction can be active at a time. Setting any mode
 * implicitly cancels the previous one: impossible states are unrepresentable.
 */
type InteractionMode =
	| { type: 'idle' }
	| { type: 'renaming'; targetId: FileId }
	| { type: 'creating'; parentId: FileId | null; fileType: 'file' | 'folder' };

/**
 * Reactive filesystem state factory.
 *
 * Follows the tab-manager pattern: a factory function creates all state.
 * The `$lib/opensidian` singleton creates one instance and exposes it at
 * `opensidian.state.files`.
 *
 * Reactivity: `fromTable()` provides a coarse-grained `ReadonlyTableView`.
 * It is NOT per-key reactive: any change to the table re-runs every reader.
 * `childrenOf` derives tree structure eagerly (O(n) iteration on any row
 * change: acceptable for <5000 files). Paths are computed lazily via
 * `computePath()`, but because the view is coarse-grained, any table change
 * re-runs path-dependent derivations too.
 *
 * @example
 * ```svelte
 * <script>
 *   import { opensidian } from '$lib/opensidian';
 *   const children = opensidian.state.files.rootChildIds;
 * </script>
 * ```
 */
export function createFilesState({
	workspace,
}: {
	workspace: OpensidianBrowser;
}) {
	// ── Reactive source ──────────────────────────────────────────────
	const filesView = fromTable(workspace.tables.files);

	// ── Reactive state ───────────────────────────────────────────────
	const openFileIds = new SvelteSet<FileId>();
	const expandedIds = new SvelteSet<FileId>();
	let focusedId = $state<FileId | null>(null);

	// ── Interaction mode ─────────────────────────────────────────────
	// A single discriminated union prevents conflicting modes
	// (e.g. can't rename and create at the same time).
	let interactionMode = $state.raw<InteractionMode>({ type: 'idle' });

	// ── Context menu hover persistence ───────────────────────────────
	// Tracks which tree item's context menu is currently open so the
	// item stays visually highlighted while the mouse is on the menu.
	let contextMenuTargetId = $state<FileId | null>(null);

	// ── Derived tree structure ───────────────────────────────────────
	//
	// childrenOf iterates the full filesView (creating an all-key dependency),
	// so it recomputes on ANY row change: even non-structural edits like
	// updatedAt bumps. At O(n) Map iteration for <5000 files this is <1ms,
	// an intentional trade-off over the complexity of structural-only tracking.

	/** Parent→children mapping. Groups non-trashed file IDs by parentId. */
	const childrenOf = $derived.by(() => {
		const map = new Map<FileId | null, FileId[]>();
		for (const row of filesView.all) {
			if (row.trashedAt !== null) continue;
			const siblings = map.get(row.parentId) ?? [];
			siblings.push(row.id);
			map.set(row.parentId, siblings);
		}
		return map;
	});

	// ── Lazy path computation ────────────────────────────────────────

	/**
	 * Build the full POSIX path for a file by walking up the ancestor chain.
	 *
	 * O(depth) per call: typically 3-5 `filesView.byId()` lookups. The view is
	 * coarse-grained, so in a reactive context (`$derived`) any table change
	 * re-runs the derivation. In an imperative context (action methods), it's a
	 * plain lookup with no reactive cost.
	 *
	 * Replaces the previous eager `pathIndex` derived which rebuilt all paths
	 * (O(n) string concatenation) on any row change.
	 *
	 * @example
	 * ```typescript
	 * // In $derived: tracks only activeFile + ancestors
	 * const path = $derived(computePath(activeFileId));
	 *
	 * // In action: plain lookup, no reactive tracking
	 * const oldPath = computePath(id);
	 * ```
	 */
	function computePath(id: FileId): string | null {
		const row = filesView.byId(id);
		if (!row || row.trashedAt !== null) return null;

		const parts: string[] = [row.name];
		let parentId = row.parentId;

		while (parentId !== null) {
			const parent = filesView.byId(parentId);
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
	 * Looked up via `filesView.byId()`. The view is coarse-grained, so any
	 * table change re-runs this derivation.
	 */
	const selectedNode = $derived.by(() => {
		const fileId = searchParams.file;
		return fileId ? (filesView.byId(fileId) ?? null) : null;
	});
	/**
	 * Active file's full POSIX path.
	 *
	 * Computed via `computePath`. The view is coarse-grained, so any table
	 * change (including unrelated rows) re-runs this derivation.
	 */
	const selectedPath = $derived.by(() => {
		const fileId = searchParams.file;
		return fileId ? computePath(fileId) : null;
	});

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
			toast.error(fallbackMessage, { description: extractErrorMessage(err) });
			console.error(err);
		}
	}

	const state = {
		// ── Read-only getters ───────────────────────────────────────
		get activeFileId(): FileId | null {
			return searchParams.file;
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

		/** Get child FileIds of a folder. Reactive via `childrenOf` derived. */
		getChildren(parentId: FileId | null) {
			return childrenOf.get(parentId) ?? [];
		},

		/**
		 * Get the FileRow for a given ID.
		 * Returns null if the row is deleted/invalid.
		 */
		getFile(id: FileId): FileRow | null {
			return filesView.byId(id) ?? null;
		},

		/**
		 * Build the full POSIX path for a file by walking up its ancestor chain.
		 *
		 * In reactive contexts (e.g., inside `$derived`), the coarse-grained
		 * view means any table change re-runs the derivation. In imperative
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
		 * const visibleIds = fs.walkTree((id, row) => ({
		 *   collect: id,
		 *   descend: row.type === 'folder' && fs.isExpanded(id),
		 * }));
		 *
		 * // Collect only files with metadata
		 * const allFiles = fs.walkTree((id, row) => {
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
					const row = filesView.byId(childId);
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
			const focused = focusedId ?? searchParams.file;
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
			searchParams.update({ file: id });
			openFileIds.add(id);
		},

		closeFile(id: FileId) {
			openFileIds.delete(id);
			if (searchParams.file === id) {
				const next = [...openFileIds].at(-1) ?? null;
				searchParams.update({ file: next });
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
				await workspace.fs.writeFile(path, '');
				toast.success(`Created ${path}`);
			}, 'Failed to create file');
		},

		async createFolder(parentId: FileId | null, name: string) {
			await withErrorToast(async () => {
				const parentPath = parentId ? (state.getPath(parentId) ?? '/') : '/';
				const path = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
				await workspace.fs.mkdir(path);
				if (parentId) expandedIds.add(parentId);
				toast.success(`Created ${path}/`);
			}, 'Failed to create folder');
		},

		async deleteFile(id: FileId) {
			await withErrorToast(async () => {
				const path = state.getPath(id);
				if (!path) return;
				await workspace.fs.rm(path, { recursive: true });
				if (searchParams.file === id) searchParams.update({ file: null });
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
				await workspace.fs.mv(oldPath, newPath);
				toast.success(`Renamed to ${newName}`);
			}, 'Failed to rename');
		},
	};

	return state;
}

export type FilesState = ReturnType<typeof createFilesState>;
