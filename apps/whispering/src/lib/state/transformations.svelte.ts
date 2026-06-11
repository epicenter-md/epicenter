/**
 * Reactive transformation state backed by Yjs workspace tables.
 *
 * Replaces TanStack Query + BlobStore for transformation CRUD. The workspace
 * model stores transformations as metadata rows (title, description, timestamps)
 * without embedded steps. Steps live in a separate `transformationSteps` table.
 *
 * @example
 * ```typescript
 * import { transformations } from '$lib/state/transformations.svelte';
 *
 * // Read reactively
 * const transformation = transformations.get(id);
 * const all = transformations.sorted; // alphabetical by title
 *
 * // Write
 * transformations.set(transformation);
 * transformations.delete(id);
 * ```
 */

import { fromTable } from '@epicenter/svelte';
import { nanoid } from 'nanoid/non-secure';
import { whispering } from '#platform/whispering';
import type { Transformation, TransformationStep } from '$lib/workspace';
import { transformationSteps } from './transformation-steps.svelte';

function createTransformations() {
	const map = fromTable(whispering.tables.transformations);

	// Memoize sorted array with $derived for referential stability.
	const sorted = $derived(
		[...map.values()].sort((a, b) => a.title.localeCompare(b.title)),
	);

	return {
		[Symbol.dispose]() {
			map[Symbol.dispose]();
		},

		/**
		 * All transformations as a reactive SvelteMap.
		 *
		 * Components reading this re-render per-key when transformations change.
		 */
		get all() {
			return map;
		},

		/**
		 * Get a transformation by ID. Returns undefined if not found.
		 */
		get(id: string) {
			return map.get(id);
		},

		/**
		 * All transformations as a sorted array (alphabetical by title).
		 * Memoized via `$derived`. Stable reference until SvelteMap changes.
		 */
		get sorted(): Transformation[] {
			return sorted;
		},

		/**
		 * Create or update a transformation. Writes to Yjs → observer updates SvelteMap.
		 */
		set(transformation: Transformation) {
			whispering.tables.transformations.set(transformation);
		},

		/**
		 * Partially update a transformation by ID.
		 */
		update(id: string, partial: Partial<Omit<Transformation, 'id' | '_v'>>) {
			return whispering.tables.transformations.update(id, partial);
		},

		/**
		 * Delete a transformation by ID.
		 */
		delete(id: string) {
			whispering.tables.transformations.delete(id);
		},

		/** Total number of transformations. */
		get count() {
			return map.size;
		},
	};
}

export const transformations = createTransformations();

if (import.meta.hot) {
	import.meta.hot.dispose(() => transformations[Symbol.dispose]());
}

/**
 * Generate a default transformation with sensible defaults.
 *
 * Includes `_v` so the returned value is a full `Transformation` ready
 * for workspace writes without any Omit gymnastics.
 *
 * @example
 * ```typescript
 * const t = generateDefaultTransformation();
 * transformations.set(t);
 * ```
 */
export function generateDefaultTransformation(): Transformation {
	const now = new Date().toISOString();
	return {
		id: nanoid(),
		title: '',
		description: '',
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * Atomically save a transformation and its steps in a single workspace batch.
 *
 * Works for both create and update:
 * - Sets `updatedAt` to now (harmless on create since it was already "now").
 * - Deletes existing steps first (no-op on create since none exist yet),
 *   then re-inserts with correct ordering.
 *
 * Callers should pass `$state.snapshot()` values. This function takes plain data.
 *
 * @example
 * ```typescript
 * const snap = $state.snapshot(transformation);
 * const stepsSnap = $state.snapshot(steps);
 * saveTransformationWithSteps(snap, stepsSnap);
 * ```
 */
export function saveTransformationWithSteps(
	transformation: Transformation,
	steps: TransformationStep[],
) {
	whispering.ydoc.transact(() => {
		transformations.set({
			...transformation,
			updatedAt: new Date().toISOString(),
		});
		transformationSteps.deleteByTransformationId(transformation.id);
		for (const [order, step] of steps.entries()) {
			transformationSteps.set({
				...step,
				transformationId: transformation.id,
				order,
			});
		}
	});
}
