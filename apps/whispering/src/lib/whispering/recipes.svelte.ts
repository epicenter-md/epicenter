/**
 * Recipes, read straight out of the document.
 *
 * A user recipe's identity IS its minted row id, and the built-in ones ship in
 * code under a `builtin:` prefix and are not rows at all (`workspace/index.ts`,
 * ADR-0099, ADR-0206). So the `sourceId` column and the two-way id map that
 * used to live here are both gone.
 *
 * This is a `.svelte.ts` module because the state IS reactive state, and runes
 * own that. It previously held four `let`s, a `Set` of listeners, a `notify`
 * fanout and a `subscribe` method, which together reimplemented `$state` by
 * hand; and `pickable` was recomputed inside the read, which is what `$derived`
 * is for. It also held a generation counter, an `isDisposed` flag and a retry
 * loop, all of which arbitrated between asynchronous reads that could land out
 * of order. Reads are synchronous now (ADR-0215), so none of that can happen.
 */
import type { NonconformingRowError } from '@epicenter/lens';
import { BUILTIN_RECIPES } from '../state/builtin-recipes';
import type { Recipe, WhisperingData } from '../workspace';

/** The shipped recipes are read-only, so editing one writes a copy. */
const BUILTIN_PREFIX = 'builtin:';

export function createWhisperingRecipes({
	table,
}: {
	table: WhisperingData['tables']['recipes'];
}) {
	let rows = $state.raw<Recipe[]>([]);
	let nonconforming = $state.raw<NonconformingRowError[]>([]);
	let loadError = $state.raw<unknown>(null);

	function read(): void {
		const { data, error } = table.list();
		if (error !== null) {
			// Reported rather than swallowed: a failed read leaves `rows` at its
			// last value, and for a first read that is empty, which renders as
			// "you have never written one of these".
			loadError = error;
			return;
		}
		rows = data.rows;
		nonconforming = data.nonconforming;
		loadError = null;
	}

	read();
	const stop = table.subscribe(read);

	return {
		[Symbol.dispose]: stop,
		/** The shipped recipes and the person's own, in one list for the picker. */
		get pickable(): Recipe[] {
			return [
				...BUILTIN_RECIPES,
				...rows.toSorted((left, right) => left.name.localeCompare(right.name)),
			];
		},
		/** How many the person wrote. The built-in ones are not theirs. */
		get count(): number {
			return rows.length;
		},
		get nonconforming(): NonconformingRowError[] {
			return nonconforming;
		},
		get loadError(): unknown {
			return loadError;
		},
		/** Save a recipe. A built-in one is copied rather than overwritten. */
		set({ id, ...fields }: Recipe): void {
			// A built-in is not a row, so saving one mints a copy the person owns.
			// So does an id this store has never seen, which is what a recipe
			// carried over from another device looks like before it syncs.
			const isRow =
				!id.startsWith(BUILTIN_PREFIX) && rows.some((row) => row.id === id);
			const { error } = isRow ? table.update(id, fields) : table.create(fields);
			if (error !== null) throw error;
			read();
		},
		delete(id: string): void {
			if (id.startsWith(BUILTIN_PREFIX)) return;
			const { error } = table.delete(id);
			if (error !== null) throw error;
			read();
		},
	};
}

export type WhisperingRecipes = ReturnType<typeof createWhisperingRecipes>;
