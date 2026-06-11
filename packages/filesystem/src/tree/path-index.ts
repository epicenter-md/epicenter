import type { Table } from '@epicenter/workspace';
import type * as Y from 'yjs';
import { asFileId, type FileId } from '../ids.js';
import type { FileRow } from '../table.js';
import { disambiguateNames } from './naming.js';

const MAX_DEPTH = 50;

/** Path-relevant fields tracked per row for incremental change detection. */
type RowSnapshot = {
	name: string;
	parentId: FileId | null;
	trashedAt: number | null;
};

function snapFrom(row: FileRow): RowSnapshot {
	return { name: row.name, parentId: row.parentId, trashedAt: row.trashedAt };
}

/**
 * Create runtime indexes for O(1) path lookups from a files table.
 *
 * Uses incremental updates: the observer classifies each changed row and
 * patches only the affected index entries instead of rebuilding everything.
 * Touch-only changes (size/updatedAt) are detected via a snapshot of
 * path-relevant fields and skipped entirely. O(1) per editing mutation.
 *
 * Teardown is hooked to `ydoc.once('destroy', ...)`. Callers do not call a
 * dispose method; destroying the workspace's Y.Doc cascades.
 */
export function attachFileSystemIndex(ydoc: Y.Doc, filesTable: Table<FileRow>) {
	/** "/docs/api.md" → FileId */
	const pathToId = new Map<string, FileId>();
	/** FileId → "/docs/api.md" (reverse lookup) */
	const idToPath = new Map<FileId, string>();
	/** parentId (null = root) → set of childIds */
	const childrenOf = new Map<FileId | null, Set<FileId>>();

	/** Previous path-relevant state for change detection. */
	const snapshot = new Map<FileId, RowSnapshot>();
	/** FileId → display name (may differ from row.name when disambiguated). */
	const displayName = new Map<FileId, string>();

	buildInitialState();

	const unobserve = filesTable.observe(processChanges);
	ydoc.once('destroy', unobserve);

	// ═══════════════════════════════════════════════════════════════════════
	// INITIAL BUILD: runs once before the observer is registered
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Build all indexes from scratch with self-healing for circular refs
	 * and orphans. Runs once during construction, before the observer
	 * subscribes before registering the observer, so table mutations from the fix helpers don't re-enter
	 * processChanges.
	 */
	function buildInitialState() {
		// getAllValid() returns fresh objects (parseRow spreads input), so we
		// can safely mutate parentId on these locals to track fix-up changes
		// without re-scanning the whole table. TypeBox's inferred row type
		// marks union-typed columns (e.g. nullable) as readonly; the cast
		// recovers mutability on the local copies.
		const activeRows: Array<{ -readonly [K in keyof FileRow]: FileRow[K] }> =
			filesTable.getAllValid().filter((r) => r.trashedAt === null);

		for (const id of fixCircularReferences(activeRows)) {
			const row = activeRows.find((r) => r.id === id);
			if (row) row.parentId = null;
		}

		for (const row of activeRows) {
			addChild(row.parentId, row.id);
		}

		for (const id of fixOrphans(activeRows)) {
			const row = activeRows.find((r) => r.id === id);
			if (row) row.parentId = null;
		}

		for (const [, childIds] of childrenOf) {
			disambiguateFolder(childIds);
		}

		buildPathsFromRoot();

		for (const row of activeRows) {
			snapshot.set(row.id, snapFrom(row));
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// INCREMENTAL UPDATE: the hot path
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Process a set of changed row IDs incrementally.
	 *
	 * Classifies each change by comparing current state against the snapshot,
	 * then patches only the affected index entries. Touch-only changes
	 * (size/updatedAt) are O(1): detected and skipped immediately.
	 */
	function processChanges(changedIds: ReadonlySet<string>) {
		const foldersToDisambiguate = new Set<FileId | null>();
		const idsNeedingPaths = new Set<FileId>();

		for (const rawId of changedIds) {
			const id = asFileId(rawId);
			const { data: row, error } = filesTable.get(id);
			const prev = snapshot.get(id);

			const isActive = row !== null && !error && row.trashedAt === null;
			const wasActive = prev !== undefined && prev.trashedAt === null;

			if (!wasActive && !isActive) {
				// Was inactive, still inactive. Keep the snapshot current for
				// inactive rows so transitions later classify correctly.
				if (prev && row !== null && !error) {
					snapshot.set(id, snapFrom(row));
				}
				continue;
			}

			if (!wasActive && isActive && row !== null) {
				// CREATED or RESTORED
				addChild(row.parentId, id);
				snapshot.set(id, snapFrom(row));
				foldersToDisambiguate.add(row.parentId);
				idsNeedingPaths.add(id);
				continue;
			}

			// Both remaining branches require prev: this is unreachable since
			// wasActive implies prev !== undefined, but the guard gives TS
			// narrowing without non-null assertions.
			if (!prev) continue;

			if (wasActive && !isActive) {
				// TRASHED or DELETED. Leave childrenOf.get(id) intact: callers
				// doing recursive cleanup (fs.rm -rf) read descendants from the
				// index after soft-deleting the parent, and restoring a trashed
				// folder should bring its descendants back with it.
				clearPathsRecursive(id);
				removeChild(prev.parentId, id);

				if (row === null) {
					snapshot.delete(id);
				} else if (!error) {
					snapshot.set(id, snapFrom(row));
				}

				displayName.delete(id);
				foldersToDisambiguate.add(prev.parentId);
				continue;
			}

			// wasActive && isActive: row is still active, check what changed.
			// isActive implies row !== null && !error.
			if (row === null || error) continue;

			const parentChanged = prev.parentId !== row.parentId;
			const nameChanged = prev.name !== row.name;

			if (!parentChanged && !nameChanged) {
				// TOUCHED: only size/updatedAt changed. No index work needed.
				continue;
			}

			if (parentChanged) {
				// MOVED
				removeChild(prev.parentId, id);
				addChild(row.parentId, id);
				foldersToDisambiguate.add(prev.parentId);
				foldersToDisambiguate.add(row.parentId);
			} else {
				// RENAMED (same parent, different name)
				foldersToDisambiguate.add(row.parentId);
			}

			clearPathsRecursive(id);
			snapshot.set(id, snapFrom(row));
			idsNeedingPaths.add(id);
			collectDescendantIds(id, idsNeedingPaths);
		}

		// Disambiguate affected folders
		for (const parentId of foldersToDisambiguate) {
			const childIds = childrenOf.get(parentId);
			if (!childIds) continue;
			const namesChanged = disambiguateFolder(childIds);

			// If any display name changed, those IDs need path recomputation
			for (const id of namesChanged) {
				clearPathsRecursive(id);
				idsNeedingPaths.add(id);
				collectDescendantIds(id, idsNeedingPaths);
			}
		}

		// Recompute paths for all affected IDs
		if (idsNeedingPaths.size > 0) {
			computePathsConvergent(idsNeedingPaths);
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// INDEX HELPERS
	// ═══════════════════════════════════════════════════════════════════════

	function addChild(parentId: FileId | null, childId: FileId): void {
		let children = childrenOf.get(parentId);
		if (!children) {
			children = new Set();
			childrenOf.set(parentId, children);
		}
		children.add(childId);
	}

	function removeChild(parentId: FileId | null, childId: FileId): void {
		childrenOf.get(parentId)?.delete(childId);
	}

	/** Remove path entries for an ID and all its descendants. */
	function clearPathsRecursive(id: FileId): void {
		const oldPath = idToPath.get(id);
		if (oldPath) {
			pathToId.delete(oldPath);
			idToPath.delete(id);
		}
		const children = childrenOf.get(id);
		if (children) {
			for (const childId of children) {
				clearPathsRecursive(childId);
			}
		}
	}

	/** Collect all descendant IDs of a node into a set. */
	function collectDescendantIds(id: FileId, out: Set<FileId>): void {
		const children = childrenOf.get(id);
		if (!children) return;
		for (const childId of children) {
			out.add(childId);
			collectDescendantIds(childId, out);
		}
	}

	/**
	 * Run disambiguation for a folder's children. Updates the displayName map.
	 *
	 * @returns IDs whose display name changed (need path recomputation).
	 */
	function disambiguateFolder(childIds: Iterable<FileId>): FileId[] {
		const changed: FileId[] = [];
		const childRows: FileRow[] = [];

		for (const cid of childIds) {
			const { data: row, error } = filesTable.get(cid);
			if (error) continue;
			if (row !== null && row.trashedAt === null) {
				childRows.push(row);
			}
		}

		const names = disambiguateNames(childRows);

		for (const [id, newName] of names) {
			const fid = asFileId(id);
			const oldName = displayName.get(fid);
			displayName.set(fid, newName);
			if (oldName !== undefined && oldName !== newName) {
				changed.push(fid);
			}
		}

		return changed;
	}

	/**
	 * Compute paths for a set of IDs using a convergent loop.
	 *
	 * Processes root-level nodes first (their parent path is known: ""),
	 * then their children become computable, and so on. Converges in
	 * O(MAX_DEPTH) iterations. IDs that fail to resolve within that bound
	 * (unreachable parent chains, depth > MAX_DEPTH) are left without a path.
	 */
	function computePathsConvergent(ids: Set<FileId>): void {
		const pending = new Set(ids);
		let progress = true;
		let iterations = 0;

		while (progress && pending.size > 0 && iterations < MAX_DEPTH) {
			progress = false;
			iterations++;

			for (const id of pending) {
				const snap = snapshot.get(id);
				if (!snap || snap.trashedAt !== null) {
					pending.delete(id);
					continue;
				}

				const name = displayName.get(id) ?? snap.name;

				if (snap.parentId === null) {
					// Root level: always computable
					const path = `/${name}`;
					pathToId.set(path, id);
					idToPath.set(id, path);
					pending.delete(id);
					progress = true;
				} else {
					const parentPath = idToPath.get(snap.parentId);
					if (parentPath !== undefined) {
						// Parent path known: compute child path
						const path = `${parentPath}/${name}`;
						pathToId.set(path, id);
						idToPath.set(id, path);
						pending.delete(id);
						progress = true;
					}
				}
			}
		}
	}

	/**
	 * Build all paths from root downward using childrenOf and displayNames.
	 * Used by buildInitialState after disambiguation. BFS level-by-level,
	 * which makes the MAX_DEPTH cap a true depth cap (iteration N processes
	 * exactly the nodes at depth N, unlike computePathsConvergent, whose
	 * iteration cap doesn't bound tree depth when pending is seeded in
	 * parent-before-child order.
	 */
	function buildPathsFromRoot(): void {
		const queue: Array<{ id: FileId; parentPath: string }> = [];

		const roots = childrenOf.get(null);
		if (roots) {
			for (const id of roots) {
				queue.push({ id, parentPath: '' });
			}
		}

		let depth = 0;
		while (queue.length > 0 && depth < MAX_DEPTH) {
			const batch = queue.splice(0, queue.length);
			depth++;

			for (const { id, parentPath } of batch) {
				const name = displayName.get(id);
				if (!name) continue;

				const path = `${parentPath}/${name}`;
				pathToId.set(path, id);
				idToPath.set(id, path);

				const children = childrenOf.get(id);
				if (children) {
					for (const childId of children) {
						queue.push({ id: childId, parentPath: path });
					}
				}
			}
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// TABLE-MUTATING FIX HELPERS (used only by buildInitialState)
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Walk parentId chains from each active row, detect cycles, and break
	 * them by moving the latest-updated node in the cycle to root.
	 *
	 * @returns Set of IDs whose parentId was mutated to null.
	 */
	function fixCircularReferences(activeRows: FileRow[]): Set<FileId> {
		const visited = new Set<FileId>();
		const inStack = new Set<FileId>();
		const mutated = new Set<FileId>();

		for (const row of activeRows) {
			if (visited.has(row.id)) continue;
			breakCycleFromId(row.id, visited, inStack, mutated);
		}

		return mutated;
	}

	function breakCycleFromId(
		startId: FileId,
		visited: Set<FileId>,
		inStack: Set<FileId>,
		mutated: Set<FileId>,
	) {
		const path: FileId[] = [];
		let currentId: FileId | null = startId;

		while (currentId !== null) {
			if (visited.has(currentId)) break;

			if (inStack.has(currentId)) {
				// Cycle detected: move the latest-updated node in the cycle to root.
				const cycleIds = path.slice(path.indexOf(currentId));
				let latestId: FileId | null = null;
				let latestTime = -1;
				for (const cid of cycleIds) {
					const { data: row, error } = filesTable.get(cid);
					if (error) continue;
					if (row !== null && row.updatedAt > latestTime) {
						latestTime = row.updatedAt;
						latestId = cid;
					}
				}
				if (latestId !== null) {
					filesTable.update(latestId, { parentId: null });
					mutated.add(latestId);
				}
				// Fall through to the cleanup loop so inStack/visited stay consistent.
				break;
			}

			inStack.add(currentId);
			path.push(currentId);

			const { data: row, error } = filesTable.get(currentId);
			if (error || row === null) break;
			currentId = row.parentId;
		}

		for (const id of path) {
			visited.add(id);
			inStack.delete(id);
		}
	}

	/**
	 * Detect orphaned rows (parentId references a deleted or non-existent
	 * row). Move orphans to root and sync childrenOf.
	 *
	 * @returns Set of IDs whose parentId was mutated to null.
	 */
	function fixOrphans(activeRows: FileRow[]): Set<FileId> {
		const activeIds = new Set(activeRows.map((r) => r.id));
		const mutated = new Set<FileId>();

		for (const row of activeRows) {
			if (row.parentId === null) continue;
			if (activeIds.has(row.parentId)) continue;

			filesTable.update(row.id, { parentId: null });
			mutated.add(row.id);
			removeChild(row.parentId, row.id);
			addChild(null, row.id);
		}

		return mutated;
	}

	// ═══════════════════════════════════════════════════════════════════════
	// PUBLIC API
	// ═══════════════════════════════════════════════════════════════════════

	return {
		/** Look up the FileId for a resolved absolute path. */
		getIdByPath(path: string): FileId | undefined {
			return pathToId.get(path);
		},
		/** Check whether a path exists in the index. */
		hasPath(path: string): boolean {
			return pathToId.has(path);
		},
		/** Get all indexed paths. */
		allPaths(): string[] {
			return Array.from(pathToId.keys());
		},
		/** Get child IDs of a parent (null = root). Returns [] if none. */
		getChildIds(parentId: FileId | null): FileId[] {
			const children = childrenOf.get(parentId);
			return children ? Array.from(children) : [];
		},
	};
}

/** Runtime indexes for O(1) path lookups (ephemeral, not stored in Yjs) */
export type FileSystemIndex = ReturnType<typeof attachFileSystemIndex>;
