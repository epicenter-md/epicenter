/**
 * Reactive transformation state backed by Yjs workspace tables.
 *
 * Replaces TanStack Query + DbService for transformation CRUD. The workspace
 * model stores transformations as metadata rows (title, description, timestamps)
 * without embedded steps—steps live in a separate `transformationSteps` table.
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
import { workspace } from '$lib/client';
import {
	type TransformationStep,
	transformationSteps,
} from './transformation-steps.svelte';

/** Transformation row type inferred from the workspace table schema. */
export type Transformation = ReturnType<
	typeof workspace.tables.transformations.getAllValid
>[number];

function createTransformations() {
	const map = fromTable(workspace.tables.transformations);

	// Memoize sorted array with $derived for referential stability.
	const sorted = $derived(
		map
			.values()
			.toArray()
			.sort((a, b) => a.title.localeCompare(b.title)),
	);

	return {
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
		 * Memoized via `$derived`—stable reference until SvelteMap changes.
		 */
		get sorted(): Transformation[] {
			return sorted;
		},

		/**
		 * Create or update a transformation. Writes to Yjs → observer updates SvelteMap.
		 */
		set(transformation: Transformation) {
			workspace.tables.transformations.set(transformation);
		},

		/**
		 * Partially update a transformation by ID.
		 */
		update(id: string, partial: Partial<Omit<Transformation, 'id' | '_v'>>) {
			return workspace.tables.transformations.update(id, partial);
		},

		/**
		 * Delete a transformation by ID.
		 */
		delete(id: string) {
			workspace.tables.transformations.delete(id);
		},

		/** Total number of transformations. */
		get count() {
			return map.size;
		},
	};
}

export const transformations = createTransformations();

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
		_v: 1,
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
 * Callers should pass `$state.snapshot()` values—this function takes plain data.
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
	workspace.batch(() => {
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
