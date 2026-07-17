import type { RowLensError } from '@epicenter/workspace/sqlite';
import { nanoid } from 'nanoid/non-secure';
import { onWhisperingRecordsChanged, whispering } from '#platform/whispering';
import { BUILTIN_RECIPES } from '$lib/state/builtin-recipes';
import type { Recipe } from '$lib/workspace';

function createRecipes() {
	let rows = $state.raw<Recipe[]>([]);
	let nonconforming = $state.raw<RowLensError[]>([]);
	let loadError = $state.raw<unknown>(null);
	let canonicalIdBySourceId = new Map<string, string>();
	let refreshGeneration = 0;
	const sorted = $derived(
		rows.toSorted((left, right) => left.name.localeCompare(right.name)),
	);
	const pickable = $derived([...BUILTIN_RECIPES, ...sorted]);

	async function refresh(): Promise<void> {
		const generation = ++refreshGeneration;
		const nextRows: Recipe[] = [];
		const nextNonconforming: RowLensError[] = [];
		const nextCanonicalIds = new Map<string, string>();
		try {
			const listed = await whispering.tables.recipes.list();
			for (const { id: canonicalId, sourceId, ...recipe } of listed.rows) {
				if (nextCanonicalIds.has(sourceId)) {
					throw new Error(`Duplicate recipe source id '${sourceId}'`);
				}
				nextCanonicalIds.set(sourceId, canonicalId);
				nextRows.push({ id: sourceId, ...recipe });
			}
			nextNonconforming.push(...listed.nonconforming);
			if (generation !== refreshGeneration) return;
			rows = nextRows;
			nonconforming = nextNonconforming;
			canonicalIdBySourceId = nextCanonicalIds;
			loadError = null;
		} catch (cause) {
			if (generation === refreshGeneration) loadError = cause;
			throw cause;
		}
	}

	const whenReady = refresh();
	onWhisperingRecordsChanged(() => void refresh().catch(() => undefined));

	return {
		whenReady,
		get pickable(): Recipe[] {
			return pickable;
		},
		get count() {
			return rows.length;
		},
		get nonconforming() {
			return nonconforming;
		},
		get loadError() {
			return loadError;
		},
		async set(recipe: Recipe): Promise<void> {
			const { id: sourceId, ...value } = recipe;
			const canonicalId = canonicalIdBySourceId.get(sourceId);
			if (canonicalId) {
				const result = await whispering.tables.recipes.update(
					canonicalId,
					value,
				);
				if (result.error !== null) throw result.error;
			} else {
				await whispering.tables.recipes.create({ sourceId, ...value });
			}
			await refresh();
		},
		async delete(id: string): Promise<void> {
			const canonicalId = canonicalIdBySourceId.get(id);
			if (!canonicalId) return;
			await whispering.tables.recipes.delete(canonicalId);
			await refresh();
		},
		refresh,
	};
}

export const recipes = createRecipes();

export function generateDefaultRecipe(): Recipe {
	return { id: nanoid(), name: '', instructions: '', icon: null };
}
