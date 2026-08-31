/**
 * `queryBooks`: read-only SQL over the local QuickBooks mirror. The `query` CLI
 * verb is a thin adapter over this; an off-the-shelf coding agent pointed at the
 * mirror artifact is the other consumer. The data leaves the machine only as the
 * rows this returns, the egress ADR-0033 already accepts.
 *
 * Read-only is enforced by the connection, not a string check: `openReadonly()`
 * hands back a connection SQLite rejects every write statement on, so even
 * arbitrary SQL cannot mutate the mirror. Results are row-capped so a broad
 * query cannot flood a caller (or a model's context).
 *
 * This core is the seam ADR-0072 leaves open: a future daemon re-exposes it with
 * `defineQuery({ handler: queryBooks })` without changing this function.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { DbFile } from '../db-file.ts';

export const BooksQueryError = defineErrors({
	NoMirror: ({ path }: { path: string }) => ({
		message: `No QuickBooks mirror at ${path}. Run "local-books sync --full" first.`,
	}),
	QueryFailed: ({ cause }: { cause: unknown }) => ({
		message: `Read-only query failed (the mirror rejects writes): ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type BooksQueryError = InferErrors<typeof BooksQueryError>;

/** Cap returned rows so a broad query cannot flood the caller. */
const MAX_ROWS = 1000;

export type BooksQueryResult = {
	rows: Record<string, unknown>[];
	/** Rows returned (at most MAX_ROWS); `truncated` flags that more matched. */
	rowCount: number;
	truncated: boolean;
};

/**
 * Run a read-only SQL query against the company's current mirror artifact. The
 * handle is opened read-only per call (cheap, and it sidesteps holding a lock
 * while a sync writes), so a query can run while `local-books sync` runs. A
 * company with no current artifact is `NoMirror`, never a file this creates.
 *
 * Rows are pulled lazily and the read STOPS at the cap: a query reads at most
 * `MAX_ROWS + 1` rows, never the full result set. This is what makes the cap a
 * real bound rather than cosmetic, since the caller is often an untrusted model:
 * a recursive CTE, a cartesian product, or any huge result set cannot
 * materialize an unbounded array and exhaust memory. The read-only connection
 * still rejects every write statement (the integrity boundary). A single
 * enormous value or a pure-CPU query is out of scope of the row cap.
 */
export function queryBooks({
	mirror,
	sql,
}: {
	mirror: DbFile;
	sql: string;
}): Result<BooksQueryResult, BooksQueryError> {
	// The open is inside the try so a corrupt or unreadable db surfaces as a
	// Result error, not an uncaught throw.
	try {
		const db = mirror.openReadonly();
		if (db === null) return BooksQueryError.NoMirror({ path: mirror.path });
		try {
			const rows: Record<string, unknown>[] = [];
			let truncated = false;
			for (const row of db.query(sql).iterate()) {
				if (rows.length === MAX_ROWS) {
					truncated = true;
					break;
				}
				rows.push(row as Record<string, unknown>);
			}
			return Ok({ rows, rowCount: rows.length, truncated });
		} finally {
			db.close();
		}
	} catch (cause) {
		return BooksQueryError.QueryFailed({ cause });
	}
}
