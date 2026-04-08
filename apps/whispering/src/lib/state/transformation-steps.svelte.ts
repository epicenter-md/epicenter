/**
 * Reactive transformation step state backed by Yjs workspace tables.
 *
 * Steps are stored as a separate table (not nested in transformations).
 * Each step has a `transformationId` FK and an `order` field for sequencing.
 * The `getByTransformationId()` helper filters and sorts by order.
 *
 * @example
 * ```typescript
 * import { transformationSteps } from '$lib/state/transformation-steps.svelte';
 *
 * // Get steps for a specific transformation, sorted by order
 * const steps = transformationSteps.getByTransformationId(transformationId);
 *
 * // CRUD
 * transformationSteps.set(step);
 * transformationSteps.delete(stepId);
 * ```
 */

import { fromTable } from '@epicenter/svelte';
import { nanoid } from 'nanoid/non-secure';
import { workspace } from '$lib/client';

/** Transformation step row type inferred from the workspace table schema. */
export type TransformationStep = ReturnType<
	typeof workspace.tables.transformationSteps.getAllValid
>[number];

function createTransformationSteps() {
	const map = fromTable(workspace.tables.transformationSteps);

	return {
		/**
		 * All transformation steps as a reactive SvelteMap.
		 */
		get all() {
			return map;
		},

		/**
		 * Get a step by ID. Returns undefined if not found.
		 */
		get(id: string) {
			return map.get(id);
		},

		/**
		 * Get all steps for a transformation, sorted by order.
		 *
		 * This is the primary query method—replaces the old `transformation.steps[]`
		 * nested array pattern. Steps are now a separate table with `transformationId` FK.
		 *
		 * @param transformationId - FK to the parent transformation
		 * @returns Steps sorted by `order` field (ascending)
		 */
		getByTransformationId(transformationId: string): TransformationStep[] {
			return Array.from(map.values())
				.filter((step) => step.transformationId === transformationId)
				.sort((a, b) => a.order - b.order);
		},

		/**
		 * Create or update a step. Writes to Yjs → observer updates SvelteMap.
		 */
		set(step: TransformationStep) {
			workspace.tables.transformationSteps.set(step);
		},

		/**
		 * Partially update a step by ID.
		 */
		update(
			id: string,
			partial: Partial<Omit<TransformationStep, 'id' | '_v'>>,
		) {
			return workspace.tables.transformationSteps.update(id, partial);
		},

		/**
		 * Delete a step by ID.
		 */
		delete(id: string) {
			workspace.tables.transformationSteps.delete(id);
		},

		/**
		 * Delete all steps for a transformation.
		 *
		 * Useful when deleting a transformation—removes all child steps.
		 */
		deleteByTransformationId(transformationId: string) {
			for (const [id, step] of map) {
				if (step.transformationId === transformationId) {
					workspace.tables.transformationSteps.delete(id);
				}
			}
		},

		/** Total number of steps across all transformations. */
		get count() {
			return map.size;
		},
	};
}

export const transformationSteps = createTransformationSteps();

/**
 * Generate a default transformation step with sensible defaults.
 *
 * Uses flat workspace field names. The `transformationId` and `order` are
 * set by the caller (they depend on the parent transformation and insertion position).
 *
 * @example
 * ```typescript
 * const step = generateDefaultStep({
 *   transformationId: transformation.id,
 *   order: existingSteps.length,
 * });
 * transformationSteps.set(step);
 * ```
 */
export function generateDefaultStep(
	context: Pick<TransformationStep, 'transformationId' | 'order'>,
): TransformationStep {
	return {
		id: nanoid(),
		transformationId: context.transformationId,
		order: context.order,
		type: 'prompt_transform',
		inferenceProvider: 'Google',
		openaiModel: 'gpt-4o',
		groqModel: 'llama-3.3-70b-versatile',
		anthropicModel: 'claude-sonnet-4-0',
		googleModel: 'gemini-2.5-flash',
		openrouterModel: 'mistralai/mixtral-8x7b',
		customModel: '',
		customBaseUrl: '',
		systemPromptTemplate: '',
		userPromptTemplate: '',
		findText: '',
		replaceText: '',
		useRegex: false,
		_v: 1,
	};
}
