/**
 * The Vault's SQLite projection: one hidden `<root>/.matter/matter.sqlite` holding one SQL table per
 * folder, named for the folder, so an agent or SQL console can JOIN across the whole vault
 * (`FROM pages JOIN adaptations`). A PROJECTION only — `assess` owns every reference verdict; SQL
 * never resolves references.
 *
 * The mirror is a SINGLE WRITER: a promise chain whose head is the open-time reset and whose every
 * link is one table's rebuild or drop. Ordering is therefore structural, not hand-managed — the reset
 * always precedes the first write, and a folder's drop-on-leave always follows its last write — so
 * there is no per-call "wait for the db" gate, no lost-rebuild race, and no overlap left for SQLite's
 * busy_timeout to untangle (that timeout stays for agent-vs-app contention). `version` bumps once per
 * applied link; the WHERE filter reads it to re-query only once the file it reads is actually fresh.
 *
 * The Vault is its sole owner: it composes one mirror per root, calls {@link syncTable} from each
 * Table's onChange, {@link dropTable} when a folder leaves, and exposes the handle so the active-pane
 * query state can {@link runQuery} it. Desktop-only: it talks to Tauri directly (no platform seam), mirroring
 * {@link createVault} / {@link createTable}.
 */

import {
	buildStemQuery,
	projectToSqlite,
	type StemQuery,
	type TableRead,
} from '@epicenter/matter-core';
import { invoke } from '@tauri-apps/api/core';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, type Result, tryAsync } from 'wellcrafted/result';

/** Open the mirror for vault `root` (the db lives at `<root>/.matter/matter.sqlite`; Rust owns that
 *  layout, this side passes only the root). Synchronous: the reset is dispatched now and becomes the
 *  head of the write-chain, so the first table write is structurally ordered after it. */
export function createMirror(root: string) {
	let version = $state(0);

	// Drop one folder's SQL table. The one structural-drop op, shared by a folder leaving (dropTable)
	// and a folder going untyped (syncTable); idempotent Rust-side (DROP TABLE IF EXISTS).
	const dropSql = (name: string) =>
		invoke('drop_mirror_table', { root, table: name });

	// The single-writer chain. Its head is the fresh-on-open reset (mkdir `.matter` + delete the db,
	// so a folder gone since last session leaves no stale table); each enqueued link runs after it and
	// bumps `version` on success. A failed link is swallowed so the chain never stalls — the next full
	// rebuild self-heals it. Projection runs inside a link (after the prior link's IPC resolved), so it
	// never lands on the synchronous batch tick that paints the grid.
	let tail: Promise<unknown> = invoke('reset_mirror', { root }).catch(() => {});
	function enqueue(run: () => Promise<unknown>): void {
		tail = tail.then(async () => {
			try {
				await run();
				version++;
			} catch {
				// fire-and-forget: a transient failure self-heals on the next batch
			}
		});
	}

	/**
	 * Rebuild one folder's SQL table from its current classified read (full DROP + CREATE + INSERT, a
	 * pure function of the folder, self-healing), or DROP it when the folder is untyped (no
	 * `matter.json` = no contract = no columns = no table). The Vault calls this from a Table's
	 * onChange, once per applied watcher batch.
	 */
	function syncTable(name: string, read: TableRead): void {
		enqueue(() => {
			if (read.view.mode !== 'typed') return dropSql(name);
			const { schema, insert, rows } = projectToSqlite(
				name,
				read.view.contract,
				read.view.conformance,
			);
			return invoke('write_mirror', { root, schema, insert, rows });
		});
	}

	/** Drop one folder's SQL table when its folder leaves the vault, so it does not linger in the
	 *  shared db. Enqueued after that folder's last write, so the table ends absent. */
	function dropTable(name: string): void {
		enqueue(() => dropSql(name));
	}

	/**
	 * Run the grid's unified query against one folder's SQL table and return the matching stems IN
	 * QUERY ORDER (an array, not a Set): SQL decides which rows, in what order, matching what text. The
	 * grid renders cells from the in-memory map in this order. The clause is the user's own raw SQL
	 * against their own read-only local db, so the worst a bad query does is return an error. No limit:
	 * the grid shows every match, never a silent cap.
	 */
	function runQuery(
		name: string,
		opts: StemQuery,
	): Promise<Result<string[], { message: string }>> {
		const sql = buildStemQuery(name, opts);
		return tryAsync({
			try: async () => {
				const { rows } = await invoke<{ rows: unknown[][] }>('query_mirror', {
					root,
					sql,
					limit: null,
				});
				return rows.map((row) => String(row[0]));
			},
			catch: (cause) => Err({ message: extractErrorMessage(cause) }),
		});
	}

	/**
	 * Run arbitrary read-only SQL for the console and return the full result set verbatim. The console
	 * renders `{ columns, rows }` directly: a JOIN or aggregate row has no file, so this never feeds an
	 * editable cell (the boundary). Fetches one row past {@link CONSOLE_LIMIT} so the console can tell a
	 * capped result from one that lands exactly on the limit, then renders only the first
	 * {@link CONSOLE_LIMIT}, so a `SELECT *` cannot hang the UI.
	 */
	function runSql(
		sql: string,
	): Promise<
		Result<{ columns: string[]; rows: unknown[][] }, { message: string }>
	> {
		return tryAsync({
			try: () =>
				invoke<{ columns: string[]; rows: unknown[][] }>('query_mirror', {
					root,
					sql,
					limit: CONSOLE_LIMIT + 1,
				}),
			catch: (cause) => Err({ message: extractErrorMessage(cause) }),
		});
	}

	return {
		syncTable,
		dropTable,
		runQuery,
		runSql,
		/** Increments after each applied mirror write or drop. Read it (reactively) to re-query once the
		 *  shared db is fresh, rather than the moment the in-memory rows change. */
		get version(): number {
			return version;
		},
	};
}

/** The most rows the SQL console renders from one query, so a `SELECT *` over a large folder cannot
 *  hang the UI. Exported so the console can say when a result was capped, rather than silently
 *  truncating. The grid query (`runQuery`) is uncapped: it returns only stems, and the grid shows
 *  every match. */
export const CONSOLE_LIMIT = 1000;

/** A live vault mirror. The Vault composes one; the active pane's query state drives it. */
export type Mirror = ReturnType<typeof createMirror>;
