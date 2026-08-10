/**
 * Recipes, read straight out of the document.
 *
 * A user recipe's identity IS its minted row id, and the built-in ones ship in
 * code under a `builtin:` prefix and are not rows at all (`workspace/index.ts`,
 * ADR-0099, ADR-0206). So the `sourceId` column and the two-way id map that
 * used to live here are both gone: there is one id space for rows and a
 * reserved prefix for the shipped ones.
 *
 * There used to be a generation counter, an `isDisposed` flag, a retry loop and
 * a `rethrow` option here as well. All four existed because reading was
 * asynchronous and two reads could land out of order. A store is one in-memory
 * document over a synchronous SQLite boundary (ADR-0215), so a read cannot race
 * another read and the machinery that arbitrated between them is gone.
 */
import type { NonconformingRowError } from '@epicenter/lens';
import { BUILTIN_RECIPES } from '../state/builtin-recipes';
import type { Recipe, WhisperingData } from '../workspace';

/** The shipped recipes are read-only, so editing one writes a copy. */
const BUILTIN_PREFIX = 'builtin:';

export type WhisperingRecipes = {
	readonly pickable: Recipe[];
	readonly count: number;
	readonly nonconforming: NonconformingRowError[];
	readonly loadError: unknown;
	/** Save a recipe. A built-in one is copied rather than overwritten. */
	set(recipe: Recipe): void;
	delete(id: string): void;
	refresh(): void;
	subscribe(listener: () => void): () => void;
	[Symbol.dispose](): void;
};

export function createWhisperingRecipes({
	table,
}: {
	table: WhisperingData['tables']['recipes'];
}): WhisperingRecipes {
	let rows: Recipe[] = [];
	let pickable: Recipe[] = BUILTIN_RECIPES;
	let nonconforming: NonconformingRowError[] = [];
	let loadError: unknown = null;
	const listeners = new Set<() => void>();

	const notify = () => {
		for (const listener of listeners) listener();
	};

	function read(): void {
		const { data, error } = table.list();
		if (error !== null) {
			// Reported rather than swallowed: a failed read leaves `rows` at its
			// last value, and for a first read that is empty, which renders as
			// "you have never written one of these".
			loadError = error;
			notify();
			return;
		}
		rows = data.rows;
		pickable = [
			...BUILTIN_RECIPES,
			...rows.toSorted((left, right) => left.name.localeCompare(right.name)),
		];
		nonconforming = data.nonconforming;
		loadError = null;
		notify();
	}

	read();
	const stop = table.subscribe(read);

	return {
		get pickable() {
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
		set({ id, ...fields }: Recipe): void {
			// A built-in is not a row, so saving one mints a copy the person owns.
			// So does an id this store has never seen, which is what a recipe
			// carried over from another device looks like before it syncs.
			const isRow = !id.startsWith(BUILTIN_PREFIX) && rows.some((r) => r.id === id);
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
		refresh: read,
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		[Symbol.dispose]: stop,
	};
}
