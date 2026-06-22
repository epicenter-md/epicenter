/**
 * Reactive Recipe state backed by the Yjs workspace table.
 *
 * A Recipe is a single self-contained row: a name and one instruction (text in,
 * text out). No replacements, no prompt split, no per-Recipe model. See ADR 0046.
 *
 * @example
 * ```typescript
 * import { recipes } from '$lib/state/recipes.svelte';
 *
 * // Read reactively: built-ins first, then the user's own (alphabetical)
 * const list = recipes.pickable;
 *
 * // Write
 * recipes.set(recipe);
 * recipes.delete(id);
 * ```
 */

import { fromTable } from '@epicenter/svelte';
import { nanoid } from 'nanoid/non-secure';
import { whispering } from '#platform/whispering';
import { BUILTIN_RECIPES } from '$lib/state/builtin-recipes';
import type { Recipe } from '$lib/workspace';

function createRecipes() {
	const map = fromTable(whispering.tables.recipes);

	// Memoize sorted array with $derived for referential stability.
	const sorted = $derived(
		[...map.values()].sort((a, b) => a.name.localeCompare(b.name)),
	);

	// Built-ins first, then the user's own (alphabetical). This is the list the
	// picker and the library both show: `builtins` union `customs`.
	const pickable = $derived([...BUILTIN_RECIPES, ...sorted]);

	return {
		[Symbol.dispose]() {
			map[Symbol.dispose]();
		},

		/**
		 * Every recipe the user can pick: built-ins first, then their own. This is
		 * what the picker and the library list. Memoized via `$derived`.
		 */
		get pickable(): Recipe[] {
			return pickable;
		},

		/** Create or update a recipe. Writes to Yjs, observer updates the SvelteMap. */
		set(recipe: Recipe) {
			whispering.tables.recipes.set(recipe);
		},

		/** Delete a recipe by ID. */
		delete(id: string) {
			whispering.tables.recipes.delete(id);
		},
	};
}

export const recipes = createRecipes();

if (import.meta.hot) {
	import.meta.hot.dispose(() => recipes[Symbol.dispose]());
}

/**
 * Generate a blank Recipe row: empty name and instructions, no icon. Ready to
 * pass straight to `recipes.set()`.
 *
 * @example
 * ```typescript
 * const r = generateDefaultRecipe();
 * recipes.set(r);
 * ```
 */
export function generateDefaultRecipe(): Recipe {
	return {
		id: nanoid(),
		name: '',
		instructions: '',
		icon: null,
	};
}
