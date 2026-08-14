/**
 * SQL over an opened workspace, composed outside the store.
 *
 * A store is truth plus debts: the live document and the ledgers that must be
 * written in the same atomic act that incurs them. Everything downstream of
 * truth is a follower an application composes on the public surface, and this
 * is the first one: an in-memory SQLite the caller can `SELECT` against.
 *
 * The contract is lazy, and laziness is what makes it honest. Any committed
 * change marks the projection dirty; the next `query` rebuilds the whole
 * database from the live document before the statement runs. There is no
 * per-edit patching and no ordering dependency on other subscribers: a read
 * repairs itself first, so `query` can never serve rows the live document has
 * moved past, from any callback, in any order. If a hot surface ever needs
 * per-row patching, it returns as an optimization behind this same contract.
 *
 * Built deliberately on nothing but the opened data's own surface (`list`,
 * `get`, `store.onCommitted`) plus the portable workspace declaration. That
 * is the proof that the follower seam is complete: an FTS index, a Markdown
 * exporter, or an embedding pipeline composes the same way.
 *
 * ```ts
 * const db = await openAccount(workspace, { principalId });
 * const sql = createSqliteProjection({ data: db, workspace, database });
 * sql.query`SELECT id, title FROM notes WHERE pinned = 1`;
 * ```
 *
 * The caller supplies `database` and owns closing it; construction is
 * therefore synchronous on every runtime, and the one genuinely asynchronous
 * step (initializing WASM SQLite in a browser) stays where it belongs, in the
 * caller's boot path:
 *
 * ```ts
 * const sqlite3 = await sqlite3InitModule();
 * const handle = new sqlite3.oo1.DB(':memory:');
 * const sql = createSqliteProjection({
 *   data: db,
 *   workspace,
 *   database: createBrowserSqliteAdapter(handle),
 * });
 * ```
 */

import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import {
	type JsonObject,
	KV_ROOT,
	parseWorkspace,
	type WorkspaceJson,
} from '@epicenter/workspace';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, type Result, trySync } from 'wellcrafted/result';

import {
	applyProjectionSchema,
	clearProjectedTable,
	insertProjectedRow,
} from './schema.js';

export const SqliteProjectionError = defineErrors({
	/**
	 * The statement could not be answered: either the SQL itself was refused (a
	 * syntax error, an unknown relation, a type SQLite will not bind), or the
	 * rebuild a dirty projection runs first failed. Refused rather than
	 * answered from a cache nothing trusts; the projection stays dirty and the
	 * next `query` tries the rebuild again.
	 */
	QueryFailed: ({ cause }: { cause: unknown }) => ({
		message: 'This statement could not be run against the projection',
		cause,
	}),
});
export type SqliteProjectionError = InferErrors<typeof SqliteProjectionError>;
export type QueryFailedError = SqliteProjectionError;

/**
 * What the projection reads from one opened table: every row, with the ones
 * the declaration cannot read reported raw, so they project as stored.
 * Structural on purpose: any typed or untyped view an opener returns
 * satisfies it.
 */
export type ProjectableTable = {
	list(): {
		rows: readonly { readonly id: string }[];
		nonconforming: readonly {
			readonly id: string;
			readonly raw: JsonObject;
		}[];
	};
};

/**
 * The slice of an opened workspace's data the projection follows.
 *
 * Dirty-marking rides `store.onCommitted` rather than per-table
 * subscriptions, and that choice is what makes freshness structural. The
 * store's flush delivers `onCommitted` BEFORE table and KV notifications, so
 * by the time any table subscriber runs, the projection already knows it is
 * dirty; a `query` inside that subscriber rebuilds first and can never serve
 * the state before the commit, regardless of who subscribed when. The one
 * honest bound: another `onCommitted` listener registered before this
 * projection was created shares its phase and may still read ahead of the
 * mark. Table and KV subscribers, the surfaces applications actually react
 * from, are always after it.
 */
export type ProjectableData = {
	readonly tables: Readonly<Record<string, ProjectableTable>>;
	readonly kv: {
		get(): {
			data: object | null;
			error: { readonly conforming: JsonObject } | null;
		};
	};
	readonly store: {
		onCommitted(listener: () => void): () => void;
	};
};

export type SqliteProjection = {
	/**
	 * Read-only SQL over the projected workspace: one relation per declared
	 * table, plus `kv` as a one-row relation.
	 *
	 * Rebuilds first when dirty, so the answer always agrees with what `list()`
	 * reports at the moment of the read. A row the declaration cannot fully
	 * read appears with its raw stored values, so SQL can show what failed.
	 */
	query(
		strings: TemplateStringsArray,
		...values: SqliteValue[]
	): Result<SqliteRow[], SqliteProjectionError>;
	/**
	 * Detach from the data's subscriptions. The database is the caller's: it
	 * was handed in, and closing it stays with whoever opened it.
	 */
	[Symbol.dispose](): void;
};

/**
 * Project one opened workspace into a SQLite database the caller supplies.
 *
 * Throwing on a declaration that does not parse, because at this call site the
 * declaration is a `defineWorkspace` literal the compiler already validated,
 * so a refusal is a programmer error rather than a boot outcome.
 */
export function createSqliteProjection({
	data,
	workspace,
	database,
}: {
	/** The opened workspace's data: the tables and KV this projection follows. */
	data: ProjectableData;
	/** The portable declaration naming the tables and fields to project. */
	workspace: WorkspaceJson;
	/**
	 * Where the projection lives. An in-memory database by convention: the
	 * projection is a cache rebuilt from the live document, and nothing here
	 * needs to survive a reload. Owned and closed by the caller.
	 */
	database: SqliteDatabase;
}): SqliteProjection {
	const { data: parsedWorkspace, error: parseError } = parseWorkspace(workspace);
	if (parseError !== null) {
		throw new Error(parseError.message, { cause: parseError });
	}
	// Rebound after the guard so the closures below see a non-null binding.
	const parsed = parsedWorkspace;

	let dirty = true;
	let disposed = false;

	// One subscription, on the phase that runs first. `onCommitted` fires for
	// every accepted change (local writes, document-plane edits, remote bytes)
	// before any table or KV subscriber hears about it, so the dirty mark is
	// in place before any follower can read.
	const detach = data.store.onCommitted(() => {
		dirty = true;
	});

	/**
	 * Rebuild everything from the live document: schema, every declared table,
	 * and KV, in one transaction. The one writer this database has.
	 */
	function rebuild(): void {
		applyProjectionSchema(database, parsed);
		database.transaction(() => {
			for (const [tableName, table] of parsed.tables) {
				const handle = data.tables[tableName];
				if (handle === undefined) continue;
				const fieldNames = [...table.fields.keys()];
				clearProjectedTable(database, tableName);
				const listed = handle.list();
				for (const row of listed.rows) {
					insertProjectedRow(
						database,
						tableName,
						fieldNames,
						row.id,
						row as JsonObject,
					);
				}
				// A row this declaration cannot fully read still exists, so it still
				// projects: raw, exactly as stored, never repaired and never hidden.
				for (const bad of listed.nonconforming) {
					insertProjectedRow(database, tableName, fieldNames, bad.id, bad.raw);
				}
			}
			const kv = parsed.kv;
			if (kv !== undefined) {
				const fieldNames = [...kv.fields.keys()];
				clearProjectedTable(database, 'kv');
				const { data: values, error } = data.kv.get();
				const payload = (values ?? error?.conforming ?? {}) as JsonObject;
				insertProjectedRow(database, 'kv', fieldNames, KV_ROOT, payload);
			}
		});
	}

	return {
		query(strings, ...values) {
			if (disposed) throw new Error('This projection is disposed');
			if (dirty) {
				const { error } = trySync({
					try: rebuild,
					catch: (cause) => SqliteProjectionError.QueryFailed({ cause }),
				});
				// Still dirty: the next query tries the rebuild again, and nothing
				// is ever answered from a cache the rebuild could not repair.
				if (error !== null) return Err(error);
				dirty = false;
			}
			return trySync({
				try: () => database.all(strings.join('?'), values),
				catch: (cause) => SqliteProjectionError.QueryFailed({ cause }),
			});
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			detach();
		},
	};
}
