/**
 * The per-pane unified query over one table's slice of the vault mirror: a WHERE filter, a full-text
 * `match`, and a column `sort`, resolved through ONE read-only SQL query to an ordered list of stems.
 *
 * This is the app's read path made coherent (ADR-0065): SQL decides which rows, in what order,
 * matching what text; the grid renders cells from the in-memory map in that order. The default view
 * stays synchronous: when no control is active (`where`, `match`, and `sort` all empty) the query
 * issues no SQL and `orderedStems` is `undefined`, so the grid paints instantly from the in-memory
 * rows in their natural order. SQL runs only once a control is on.
 *
 * The mirror is the query seam (the vault's SQLite projection); `tableName` names which folder's SQL
 * table to query. Both are taken at construction: a pane's table is non-swappable (a table switch
 * remounts TablePane with a fresh query), so there is nothing to re-point at call time. The unit owns
 * its own `$effect`, which Svelte ties to the component that constructs it (the same pattern as
 * `createPressedKeys`), so the caller just writes `const query = createTableQuery(vault.mirror, () =>
 * table.folderName)`.
 *
 * The effect re-runs on the controls (`where`, `match`, `sort`) and on `mirror.version` (bumped after
 * each mirror write or drop). Keying on the version, not the in-memory rows, means the query fires
 * only once the file it reads is fresh, so a data edit can never land a result from the pre-rebuild
 * mirror. Each run debounces, and its cleanup cancels the pending/in-flight query so a newer control
 * value or rebuild never lands a stale result.
 */

import type { Mirror } from './mirror.svelte';

/** Let a burst of keystrokes (or rapid external edits) settle before querying the mirror. */
const DEBOUNCE_MS = 200;

/** A column sort: which column, ascending or descending. `undefined` means the natural (mirror) order. */
export type Sort = { column: string; dir: 'asc' | 'desc' };

export function createTableQuery(mirror: Mirror, tableName: () => string) {
	let where = $state('');
	let match = $state('');
	let sort = $state<Sort>();
	let orderedStems = $state<string[]>();
	let error = $state<string>();

	// Active when any control is set. The grid reads this for its "X of Y" count and empty-state copy,
	// and the effect below uses it to decide whether to run SQL at all.
	const isActive = $derived(
		where.trim() !== '' || match.trim() !== '' || sort !== undefined,
	);

	// Resolve the controls to an ordered stem list whenever a control or the mirror changes. Reading
	// `mirror.version` (discarded) is the subscription: it bumps after each mirror write/drop, so the
	// query always reads a fresh file. The cleanup cancels the pending/in-flight query so a newer
	// control value or rebuild never lands a stale result.
	$effect(() => {
		const whereClause = where.trim();
		const matchText = match.trim();
		const currentSort = sort;
		void mirror.version; // re-run after the mirror is rebuilt (downstream of row edits)

		// No control active: the grid renders synchronously from the in-memory rows, so issue no SQL.
		if (!isActive) {
			orderedStems = undefined;
			error = undefined;
			return;
		}
		let cancelled = false;
		const handle = setTimeout(async () => {
			const { data, error: failure } = await mirror.runQuery(tableName(), {
				where: whereClause || undefined,
				match: matchText || undefined,
				sort: currentSort,
			});
			if (cancelled) return; // a newer control, a rebuild, or this pane being torn down won
			if (failure) error = failure.message;
			else {
				orderedStems = data;
				error = undefined;
			}
		}, DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(handle);
		};
	});

	return {
		/** The WHERE clause, two-way bound to the folder-header filter input. */
		get where() {
			return where;
		},
		set where(value: string) {
			where = value;
		},
		/** The full-text search text, two-way bound to the search input. */
		get match() {
			return match;
		},
		set match(value: string) {
			match = value;
		},
		/** The active column sort, or `undefined` for the natural order. */
		get sort() {
			return sort;
		},
		/** Cycle a column header's sort: unsorted -> ascending -> descending -> unsorted. */
		toggleSort(column: string) {
			if (sort?.column !== column) sort = { column, dir: 'asc' };
			else if (sort.dir === 'asc') sort = { column, dir: 'desc' };
			else sort = undefined;
		},
		/** The matched stems IN QUERY ORDER, or `undefined` when no control is active (render in-memory). */
		get orderedStems() {
			return orderedStems;
		},
		/** True when any control (where / match / sort) is set. */
		get isActive() {
			return isActive;
		},
		/** A bad query's message; the last good `orderedStems` is kept until it parses. */
		get error() {
			return error;
		},
	};
}

/** A per-pane unified query. The grid takes one to render its controls and order its rows. */
export type TableQuery = ReturnType<typeof createTableQuery>;
