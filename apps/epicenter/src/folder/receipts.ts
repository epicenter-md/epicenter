/**
 * What the renderer last wrote into each file.
 *
 * A file can only say what it currently holds. The receipt is the one thing that
 * can say what *you* changed, so it is written in the same breath as the file
 * and read by nothing else (ADR-0207).
 *
 * It lives beside the host's other machine state rather than in
 * `epicenter.sqlite3`. Two reasons, and the second is the real one: the Epicenter
 * runtime deliberately does not hand out its database handle, and this is the
 * renderer's bookkeeping rather than the replica's. The folder is the
 * human-facing artifact; this is the machinery behind it, so it belongs in the
 * app data root (ADR-0201) where machinery goes.
 */

import { Database } from 'bun:sqlite';
import type { JsonObject, RowAddress } from '@epicenter/lens';

export type Receipt = {
	address: RowAddress;
	/** Exactly the fields rendered into the file, including the body field. */
	fields: JsonObject;
};

type ReceiptRow = {
	path: string;
	namespace: string;
	table_name: string;
	row_id: string;
	fields: string;
};

export type ReceiptStore = {
	get(path: string): Receipt | undefined;
	/** Record a render. Replaces any previous receipt for the same path. */
	record(path: string, receipt: Receipt): void;
	forget(path: string): void;
	paths(): string[];
	close(): void;
};

/**
 * Open the receipt store at a path, creating it if needed.
 *
 * Losing this file is safe and self-healing: every file becomes `unbased`, which
 * refuses to push rather than guessing, and the next render records fresh
 * receipts. The only cost is unpushed edits, which have to be re-made.
 */
export function openReceiptStore(databasePath: string): ReceiptStore {
	const database = new Database(databasePath, { create: true });
	database.run('PRAGMA journal_mode = WAL');
	database.run(`CREATE TABLE IF NOT EXISTS folder_receipts (
		path TEXT PRIMARY KEY,
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL,
		fields TEXT NOT NULL
	) STRICT`);

	return {
		get(path) {
			const row = database
				.query<ReceiptRow, [string]>(
					'SELECT * FROM folder_receipts WHERE path = ?',
				)
				.get(path);
			if (row === null) return undefined;
			return {
				address: {
					namespace: row.namespace,
					tableName: row.table_name,
					rowId: row.row_id,
				},
				fields: JSON.parse(row.fields) as JsonObject,
			};
		},
		record(path, receipt) {
			database.run(
				`INSERT INTO folder_receipts (path, namespace, table_name, row_id, fields)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT (path) DO UPDATE SET
					namespace = excluded.namespace,
					table_name = excluded.table_name,
					row_id = excluded.row_id,
					fields = excluded.fields`,
				[
					path,
					receipt.address.namespace,
					receipt.address.tableName,
					receipt.address.rowId,
					JSON.stringify(receipt.fields),
				],
			);
		},
		forget(path) {
			database.run('DELETE FROM folder_receipts WHERE path = ?', [path]);
		},
		paths() {
			return database
				.query<{ path: string }, []>(
					'SELECT path FROM folder_receipts ORDER BY path',
				)
				.all()
				.map((row) => row.path);
		},
		close() {
			database.close();
		},
	};
}
