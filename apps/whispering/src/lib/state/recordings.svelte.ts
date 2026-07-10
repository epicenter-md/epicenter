/**
 * Reactive recording state backed by Yjs workspace tables.
 *
 * Reads go through a `fromTable` view, a coarse-grained `ReadonlyTableView`:
 * any recording change re-runs every reader (not per-key). Writes delegate to
 * the workspace table; the Yjs observer behind the view picks up local writes,
 * remote CRDT sync, and migration.
 *
 * Audio blob access still goes through BlobStore (blobs are too large for CRDTs).
 *
 * @example
 * ```typescript
 * import { recordings } from '$lib/state/recordings.svelte';
 *
 * const recording = recordings.get(id);
 * const all = recordings.sorted; // newest first
 *
 * recordings.set(recording);
 * recordings.delete(id);
 * ```
 */
import { fromTable } from '@epicenter/svelte';
import { whispering } from '#platform/whispering';
import type { Recording } from '$lib/workspace';

/** Re-exported from the workspace definition for consumer convenience. */
export type { Recording } from '$lib/workspace';

function createRecordings() {
	const view = fromTable(whispering.tables.recordings);

	// Memoize sorted array with $derived so consumers get a stable reference.
	// `toSorted` returns a fresh sorted array (the view's `all` is a shared,
	// readonly scan, so it must not be sorted in place). The `$derived` memoizes
	// this copy, handing out a stable reference between changes. Without that
	// stability TanStack Table's $derived sees "new data" every access → updates
	// internal $state → re-triggers $derived → infinite loop.
	const sorted = $derived(
		view.all.toSorted(
			(a, b) =>
				new Date(b.recordedAt as string).getTime() -
				new Date(a.recordedAt as string).getTime(),
		),
	);

	return {
		/**
		 * Get a recording by ID. Returns undefined if not found.
		 *
		 * Reads from the reactive table view. Triggers re-render if any
		 * recording changes (the view is coarse-grained).
		 */
		get(id: string) {
			return view.byId(id);
		},

		/**
		 * All recordings as a sorted array (newest first by recordedAt).
		 *
		 * Memoized via `$derived`. Returns a stable reference until the table
		 * actually changes. This is critical for TanStack Table, which uses
		 * reference equality to detect data changes.
		 */
		get sorted(): Recording[] {
			return sorted;
		},

		/**
		 * Create or update a recording. Writes to Yjs; the view re-reads on the
		 * observer signal.
		 *
		 * Accepts a recording without `_v` (version tag is added automatically).
		 * No manual cache invalidation needed; reads are live through the table.
		 */
		set(recording: Omit<Recording, '_v'>) {
			whispering.tables.recordings.set({ ...recording } as Recording);
		},

		/**
		 * Partially update a recording by ID.
		 *
		 * Reads the current row, merges the partial fields, validates, and writes.
		 * Returns the update result for error handling.
		 */
		update(id: string, partial: Partial<Omit<Recording, 'id' | '_v'>>) {
			return whispering.tables.recordings.update(id, partial);
		},

		/**
		 * Delete a recording by ID.
		 *
		 * Low-level row-only deletion. User and retention flows must use the shared
		 * recording deletion operation so native artifact failure preserves this row.
		 */
		delete(id: string) {
			whispering.tables.recordings.delete(id);
		},

		/**
		 * Delete multiple recordings by ID in a single optimized scan.
		 *
		 * Uses the workspace table's bulkDelete (O(n) single scan) instead of
		 * looping delete calls (O(n²)). This is the final row-only step of the
		 * shared recording deletion operation, not a public cleanup workflow.
		 */
		async bulkDelete(ids: string[]) {
			await whispering.tables.recordings.bulkDelete(ids);
		},

		/** Total number of recordings. */
		get count() {
			return view.all.length;
		},
	};
}

export const recordings = createRecordings();
