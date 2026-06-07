/**
 * FTS5 full-text search for the SQLite materializer.
 *
 * Owns the FTS5 virtual table DDL, content-sync triggers, the search SQL, and
 * the `search` action exposed in the materializer's `actions` registry as `sqlite_search`.
 * Kept out of `core.ts` so the materializer body only knows about Y.Doc →
 * SQLite mirroring; the SQLite → FTS5 step lives entirely here.
 *
 * @module
 */

import type { Database } from 'bun:sqlite';
import Type from 'typebox';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import type { Logger } from 'wellcrafted/logger';
import { defineQuery } from '../../../shared/actions.js';
import type { TablesRecord } from '../shared.js';
import type { FtsConfig } from './core.js';
import { quoteIdentifier } from './ddl.js';

// ════════════════════════════════════════════════════════════════════════════
// FTS ERRORS
// ════════════════════════════════════════════════════════════════════════════

/** Errors logged by the FTS search path. Module-local; not exported. */
const FtsError = defineErrors({
	/** An FTS5 MATCH query raised inside the mirror database. */
	FtsSearchFailed: ({
		tableName,
		query,
		cause,
	}: {
		tableName: string;
		query: string;
		cause: unknown;
	}) => ({
		message: `[sqlite-materializer] FTS search failed on table "${tableName}" for query "${query}": ${extractErrorMessage(cause)}`,
		tableName,
		query,
		cause,
	}),
});

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC SEARCH TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Optional arguments for FTS5 searches.
 *
 * Use this when you want to cap result count or choose which indexed column is
 * used for snippets in the search response.
 */
export type SearchOptions = {
	/** Maximum number of matches to return. */
	limit?: number;

	/** Column name used to generate the snippet text. */
	snippetColumn?: string;
};

/**
 * One full-text search result returned by the materializer.
 *
 * `id` points back to the materialized row, `snippet` is display-ready text, and
 * `rank` is the database-provided relevance score.
 */
export type SearchResult = {
	/** ID of the materialized row that matched the query. */
	id: string;

	/** Snippet generated from indexed text content. */
	snippet: string;

	/** Relevance score returned by the FTS query. */
	rank: number;
};

// ════════════════════════════════════════════════════════════════════════════
// FTS SETUP
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create FTS5 virtual table and content-sync triggers for a materializer table.
 * Module-private: only `createSqliteFtsLayer` below calls this.
 *
 * Sets up:
 * 1. `CREATE VIRTUAL TABLE IF NOT EXISTS {table}_fts USING fts5(...)` with content sync
 * 2. AFTER INSERT trigger to index new rows
 * 3. AFTER DELETE trigger to remove deleted rows
 * 4. AFTER UPDATE trigger to re-index changed rows
 */
async function setupFtsTable(
	db: Database,
	tableName: string,
	columns: string[],
): Promise<void> {
	const ftsTableName = `${tableName}_fts`;
	const quotedColumns = columns.map(quoteIdentifier).join(', ');
	const newValues = columns
		.map((column) => `new.${quoteIdentifier(column)}`)
		.join(', ');
	const oldValues = columns
		.map((column) => `old.${quoteIdentifier(column)}`)
		.join(', ');

	const qt = quoteIdentifier(tableName);
	const qfts = quoteIdentifier(ftsTableName);

	await db.run(
		`CREATE VIRTUAL TABLE IF NOT EXISTS ${qfts}\n` +
			`USING fts5(${quotedColumns}, content=${quoteString(tableName)}, content_rowid=rowid)`,
	);

	await db.run(
		`CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${tableName}_fts_ai`)}\n` +
			`AFTER INSERT ON ${qt} BEGIN\n` +
			`  INSERT INTO ${qfts}(rowid, ${quotedColumns})\n` +
			`  VALUES (new.rowid, ${newValues});\n` +
			`END`,
	);

	await db.run(
		`CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${tableName}_fts_ad`)}\n` +
			`AFTER DELETE ON ${qt} BEGIN\n` +
			`  INSERT INTO ${qfts}(${qfts}, rowid, ${quotedColumns})\n` +
			`  VALUES('delete', old.rowid, ${oldValues});\n` +
			`END`,
	);

	await db.run(
		`CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${tableName}_fts_au`)}\n` +
			`AFTER UPDATE ON ${qt} BEGIN\n` +
			`  INSERT INTO ${qfts}(${qfts}, rowid, ${quotedColumns})\n` +
			`  VALUES('delete', old.rowid, ${oldValues});\n` +
			`  INSERT INTO ${qfts}(rowid, ${quotedColumns})\n` +
			`  VALUES (new.rowid, ${newValues});\n` +
			`END`,
	);
}

// ════════════════════════════════════════════════════════════════════════════
// FTS SEARCH
// ════════════════════════════════════════════════════════════════════════════

/**
 * Execute a FTS5 search query against a materialized table.
 * Module-private: called by `createSqliteFtsLayer`'s `search` handler.
 *
 * Returns ranked results with snippet text. The query is trimmed and
 * empty queries return an empty array. If the FTS table doesn't exist
 * or the query fails, returns an empty array with a warning.
 */
async function ftsSearch(
	db: Database,
	tableName: string,
	ftsColumns: string[],
	query: string,
	{ limit = 50, snippetColumn }: SearchOptions = {},
	log?: Logger,
): Promise<SearchResult[]> {
	const trimmed = query.trim();
	if (!trimmed) {
		return [];
	}

	const snippetColumnIndex = snippetColumn
		? Math.max(ftsColumns.indexOf(snippetColumn), 0)
		: 0;

	try {
		const stmt = await db.prepare(
			buildFtsSearchSql(tableName, snippetColumnIndex),
		);
		const rows = await stmt.all(trimmed, limit);

		return mapFtsSearchRows(rows);
	} catch (cause: unknown) {
		log?.warn(
			FtsError.FtsSearchFailed({
				tableName,
				query: trimmed,
				cause,
			}),
		);
		return [];
	}
}

// ════════════════════════════════════════════════════════════════════════════
// INTERNAL FTS LAYER
// ════════════════════════════════════════════════════════════════════════════

/**
 * Internal factory that owns the materializer's FTS surface.
 *
 * Constructed by `attachSqliteMaterializerCore` only when the caller passed an
 * `fts` option. Holds the FTS column map, exposes a `setupForBulkLoad()` pass
 * that installs FTS virtual tables and triggers after table DDL and before the
 * bulk insert, and surfaces the `search` action that lands on
 * `materializer.actions.sqlite_search`.
 *
 * Pure construction at call time: registers no listeners and runs no DDL.
 * Returning the factory unconditionally would be fine; the caller decides
 * whether to call it based on whether `fts` was provided, so the materializer's
 * action registry only includes `sqlite_search` when FTS was configured.
 *
 * @internal
 */
export function createSqliteFtsLayer<TTables extends TablesRecord>({
	db,
	fts,
	log,
}: {
	db: Database;
	fts: FtsConfig<TTables>;
	log: Logger;
}) {
	const ftsColumns = new Map<string, string[]>();
	for (const [tableName, columns] of Object.entries(fts)) {
		if (Array.isArray(columns) && columns.length > 0) {
			ftsColumns.set(tableName, columns as string[]);
		}
	}

	async function setupForBulkLoad(): Promise<void> {
		for (const [tableName, columns] of ftsColumns) {
			await setupFtsTable(db, tableName, columns);
		}
	}

	const search = defineQuery({
		title: 'Full-text search',
		description: 'FTS5 search across materialized table rows',
		input: Type.Object({
			table: Type.String(),
			query: Type.String(),
			limit: Type.Optional(Type.Number()),
			snippetColumn: Type.Optional(Type.String()),
		}),
		handler: ({ table, query, limit, snippetColumn }) => {
			const columns = ftsColumns.get(table);
			if (columns === undefined || columns.length === 0) {
				return Promise.resolve<SearchResult[]>([]);
			}
			return ftsSearch(
				db,
				table,
				columns,
				query,
				limit !== undefined || snippetColumn !== undefined
					? { limit, snippetColumn }
					: undefined,
				log,
			);
		},
	});

	return { setupForBulkLoad, search };
}

// ════════════════════════════════════════════════════════════════════════════
// SEARCH SQL HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the shared FTS5 search query used by both the writer-side search action
 * and the read-only SQLite mirror reader. Execution stays caller-owned so the
 * writer action can catch and log FTS failures while the reader stays sync.
 *
 * @internal
 */
export function buildFtsSearchSql(
	tableName: string,
	snippetColumnIndex: number,
): string {
	const qt = quoteIdentifier(tableName);
	const qfts = quoteIdentifier(`${tableName}_fts`);
	return (
		`SELECT ${qt}.${quoteIdentifier('id')} AS id,\n` +
		`  snippet(${qfts}, ${snippetColumnIndex}, '<mark>', '</mark>', '...', 64) AS snippet,\n` +
		`  rank\n` +
		`FROM ${qfts}\n` +
		`JOIN ${qt} ON ${qt}.rowid = ${qfts}.rowid\n` +
		`WHERE ${qfts} MATCH ?\n` +
		`ORDER BY rank LIMIT ?`
	);
}

/**
 * Map SQLite result rows into the public search result shape.
 *
 * @internal
 */
export function mapFtsSearchRows(rows: readonly unknown[]): SearchResult[] {
	return rows.map((row) => {
		const result = row as Record<string, unknown>;
		return {
			id: String(result.id),
			snippet: String(result.snippet ?? ''),
			rank: Number(result.rank ?? 0),
		};
	});
}

// ════════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ════════════════════════════════════════════════════════════════════════════

function quoteString(value: string) {
	return `'${value.replaceAll("'", "''")}'`;
}
