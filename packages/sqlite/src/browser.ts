import type { SqliteDatabase, SqliteRow, SqliteValue } from './index.js';

/**
 * The exact surface of sqlite.org's OO1 `DB` this adapter drives.
 *
 * Structural rather than a type-only import of `@sqlite.org/sqlite-wasm`, so
 * assignability is checked at each call site against the version that caller
 * actually installed; a types-only devDependency here could silently skew
 * from the runtime the caller ships. `exec` is declared as the two call
 * shapes the adapter makes (run for effects; collect object rows), because
 * OO1's own overload set has no signature with an OPTIONAL `rowMode`: its
 * object-rows overload requires `rowMode: 'object'` and its default overload
 * forbids it, so a single merged signature is satisfiable by nothing and
 * forced a cast at every construction site.
 *
 * `transaction` takes no BEGIN qualifier. The one database this adapter ever
 * wraps is a `:memory:` projection cache with a single connection for its
 * whole life, and lock-escalation qualifiers (`IMMEDIATE`) only order writers
 * across connections; carrying one here was cross-runtime ceremony inherited
 * from the file-backed Bun adapter.
 *
 * `transaction` does not nest, and this adapter does not pretend it does. No
 * production caller nests (the store's projection rebuild is the only
 * browser-reachable transaction), OO1 itself throws loudly on a nested
 * `BEGIN`, and OO1 ships a native `savepoint()` for the day nesting earns
 * itself. The hand-rolled `SAVEPOINT epicenter_nested_*` emulation that used
 * to live here served zero callers.
 */
export type BrowserSqliteDatabase = {
	exec(options: { sql: string; bind?: readonly SqliteValue[] }): unknown;
	exec(options: {
		sql: string;
		bind?: readonly SqliteValue[];
		rowMode: 'object';
		resultRows: SqliteRow[];
	}): unknown;
	transaction<TResult>(run: () => TResult): TResult;
};

/** Adapt sqlite.org's OO1 browser API without importing a WASM implementation. */
export function createBrowserSqliteAdapter(
	database: BrowserSqliteDatabase,
): SqliteDatabase {
	return {
		run(sql, parameters = []): void {
			database.exec({ sql, bind: parameters });
		},
		all<TRow extends SqliteRow>(sql: string, parameters = []): TRow[] {
			const resultRows: SqliteRow[] = [];
			database.exec({ sql, bind: parameters, rowMode: 'object', resultRows });
			// The row shape is the caller's promise about the statement, exactly
			// as in the Bun adapter; SQLite cannot verify it either way.
			return resultRows as TRow[];
		},
		transaction<TResult>(run: () => TResult): TResult {
			return database.transaction(run);
		},
	};
}
