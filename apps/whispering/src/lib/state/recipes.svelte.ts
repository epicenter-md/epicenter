import { nanoid } from 'nanoid/non-secure';
import { createSubscriber } from 'svelte/reactivity';
import type { WhisperingApplication } from '$lib/whispering/application';
import type { Recipe } from '$lib/workspace';

export type Recipes = ReturnType<typeof createRecipes>;

/** Adds Svelte dependency tracking to the UI-free recipes namespace. */
export function createRecipes({
	recipes,
}: Pick<WhisperingApplication, 'recipes'>) {
	const track = createSubscriber((update) => recipes.subscribe(update));
	return {
		get pickable() {
			track();
			return recipes.pickable;
		},
		get count() {
			track();
			return recipes.count;
		},
		get nonconforming() {
			track();
			return recipes.nonconforming;
		},
		get loadError() {
			track();
			return recipes.loadError;
		},
		set: recipes.set,
		delete: recipes.delete,
		refresh: recipes.refresh,
		subscribe: recipes.subscribe,
	};
}

export function generateDefaultRecipe(): Recipe {
	return { id: nanoid(), name: '', instructions: '', icon: null };
}
