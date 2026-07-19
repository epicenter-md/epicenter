import type {
	RowLensError,
	WorkspaceHandle,
} from '@epicenter/workspace/sqlite';
import { BUILTIN_RECIPES } from '../state/builtin-recipes';
import type { Recipe, whisperingWorkspace } from '../workspace';

export type WhisperingRecipes = {
	readonly pickable: Recipe[];
	readonly count: number;
	readonly nonconforming: RowLensError[];
	readonly loadError: unknown;
	set(recipe: Recipe): Promise<void>;
	delete(id: string): Promise<void>;
	refresh(): Promise<void>;
	subscribe(listener: () => void): () => void;
};

export function createWhisperingRecipes({
	workspace,
	onRecordsChanged,
	reportBackgroundError,
}: {
	workspace: WorkspaceHandle<typeof whisperingWorkspace>;
	onRecordsChanged(listener: () => void): () => void;
	reportBackgroundError(cause: unknown): void;
}) {
	let rows: Recipe[] = [];
	let pickable: Recipe[] = BUILTIN_RECIPES;
	let nonconforming: RowLensError[] = [];
	let loadError: unknown = null;
	let canonicalIdBySourceId = new Map<string, string>();
	let refreshGeneration = 0;
	let isDisposed = false;
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};

	async function refresh({ rethrow = false }: { rethrow?: boolean } = {}) {
		refreshGeneration += 1;
		while (!isDisposed) {
			const generation = refreshGeneration;
			try {
				const listed = await workspace.tables.recipes.list();
				if (isDisposed) return;
				if (generation !== refreshGeneration) continue;
				const nextRows: Recipe[] = [];
				const nextCanonicalIds = new Map<string, string>();
				for (const { id: canonicalId, sourceId, ...recipe } of listed.rows) {
					if (nextCanonicalIds.has(sourceId)) {
						throw new Error(`Duplicate recipe source id '${sourceId}'`);
					}
					nextCanonicalIds.set(sourceId, canonicalId);
					nextRows.push({ id: sourceId, ...recipe });
				}
				rows = nextRows;
				pickable = [
					...BUILTIN_RECIPES,
					...rows.toSorted((left, right) =>
						left.name.localeCompare(right.name),
					),
				];
				nonconforming = listed.nonconforming;
				canonicalIdBySourceId = nextCanonicalIds;
				loadError = null;
				notify();
			} catch (cause) {
				if (isDisposed) return;
				if (generation !== refreshGeneration) continue;
				loadError = cause;
				notify();
				if (rethrow) throw cause;
				reportBackgroundError(cause);
			}
			return;
		}
	}

	const unsubscribeRecords = onRecordsChanged(() => void refresh());
	const ready = refresh({ rethrow: true });
	const recipes: WhisperingRecipes = {
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
		async set(recipe) {
			const { id: sourceId, ...value } = recipe;
			const canonicalId = canonicalIdBySourceId.get(sourceId);
			if (canonicalId) {
				const result = await workspace.tables.recipes.update(
					canonicalId,
					value,
				);
				if (result.error !== null) throw result.error;
			} else {
				await workspace.tables.recipes.create({ sourceId, ...value });
			}
			await refresh();
		},
		async delete(id) {
			const canonicalId = canonicalIdBySourceId.get(id);
			if (!canonicalId) return;
			await workspace.tables.recipes.delete(canonicalId);
			await refresh();
		},
		refresh,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	return {
		recipes,
		ready,
		dispose() {
			isDisposed = true;
			refreshGeneration += 1;
			unsubscribeRecords();
			listeners.clear();
		},
	};
}
