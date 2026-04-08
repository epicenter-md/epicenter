/**
 * Reactive recording state backed by Yjs workspace tables.
 *
 * Replaces TanStack Query + DbService for recording CRUD. SvelteMap provides
 * per-key reactivity—updating one recording doesn't re-render the entire list.
 * The Yjs observer fires on local writes, remote CRDT sync, and migration.
 *
 * Audio blob access still goes through DbService (blobs are too large for CRDTs).
 *
 * @example
 * ```typescript
 * import { recordings } from '$lib/state/recordings.svelte';
 *
 * // Read reactively (re-renders on change)
 * const recording = recordings.get(id);
 * const all = recordings.sorted; // newest first
 *
 * // Write (Yjs observer auto-updates SvelteMap → components re-render)
 * recordings.set(recording);
 * recordings.delete(id);
 * ```
 */
import { fromTable } from '@epicenter/svelte';
import { workspace } from '$lib/client';

/** Recording row type inferred from the workspace table schema. */
export type Recording = ReturnType<
	typeof workspace.tables.recordings.getAllValid
>[number];

function createRecordings() {
	const map = fromTable(workspace.tables.recordings);

	// Memoize sorted array with $derived so consumers get a stable reference.
	// Without this, every access creates a new array → TanStack Table's $derived
	// sees "new data" → updates internal $state → re-triggers $derived → infinite loop.
	const sorted = $derived(
		map
			.values()
			.toArray()
			.sort(
				(a, b) =>
					new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
			),
	);

	return {
		/**
		 * All recordings as a reactive SvelteMap.
		 *
		 * Components reading this re-render per-key when recordings change.
		 * Use `.sorted` for a pre-sorted array, or iterate directly for
		 * custom ordering.
		 */
		get all() {
			return map;
		},

		/**
		 * Get a recording by ID. Returns undefined if not found.
		 *
		 * Reads from the reactive SvelteMap—triggers re-render if the
		 * recording changes or is deleted.
		 */
		get(id: string) {
			return map.get(id);
		},

		/**
		 * All recordings as a sorted array (newest first by timestamp).
		 *
		 * Memoized via `$derived`—returns a stable reference until the
		 * SvelteMap actually changes. This is critical for TanStack Table,
		 * which uses reference equality to detect data changes.
		 */
		get sorted(): Recording[] {
			return sorted;
		},

		/**
		 * Create or update a recording. Writes to Yjs → observer updates SvelteMap.
		 *
		 * Accepts a recording without `_v` (version tag is added automatically).
		 * No manual cache invalidation needed—the observer handles UI updates.
		 */
		set(recording: Omit<Recording, '_v'>) {
			workspace.tables.recordings.set({ ...recording, _v: 1 } as Recording);
		},

		/**
		 * Partially update a recording by ID.
		 *
		 * Reads the current row, merges the partial fields, validates, and writes.
		 * Returns the update result for error handling.
		 */
		update(id: string, partial: Partial<Omit<Recording, 'id' | '_v'>>) {
			return workspace.tables.recordings.update(id, partial);
		},

		/**
		 * Delete a recording by ID.
		 *
		 * Fire-and-forget—Yjs observer fires `map.delete(id)` automatically.
		 * Callers should clean up audio URLs before calling this.
		 */
		delete(id: string) {
			workspace.tables.recordings.delete(id);
		},

		/** Total number of recordings. */
		get count() {
			return map.size;
		},
	};
}

export const recordings = createRecordings();
