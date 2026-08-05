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
	/** Where it was written. A value, not the identity: renaming is free. */
	path: string;
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
	get(address: RowAddress): Receipt | undefined;
	/** Record a render. Replaces any previous receipt for the same row. */
	record(receipt: Receipt): void;
	forget(address: RowAddress): void;
	all(): Receipt[];
	close(): void;
};

/**
 * Open the receipt store at a path, creating it if needed.
 *
 * Losing this file is safe and self-healing: every file becomes `unbased`, which
 * refuses to push rather than guessing, and the next render records fresh
 * receipts. The only cost is unpushed edits, which have to be re-made.
 */
function toReceipt(row: ReceiptRow): Receipt {
	return {
		address: {
			namespace: row.namespace,
			tableName: row.table_name,
			rowId: row.row_id,
		},
		path: row.path,
		fields: JSON.parse(row.fields) as JsonObject,
	};
}

export function openReceiptStore(databasePath: string): ReceiptStore {
	const database = new Database(databasePath, { create: true });
	database.run('PRAGMA journal_mode = WAL');
	// Keyed by the row, not the file. The id in frontmatter is what binds a file
	// to a row (ADR-0207), so a rename is a new value here and nothing more.
	database.run(`CREATE TABLE IF NOT EXISTS folder_receipts (
		namespace TEXT NOT NULL,
		table_name TEXT NOT NULL,
		row_id TEXT NOT NULL,
		path TEXT NOT NULL,
		fields TEXT NOT NULL,
		PRIMARY KEY (namespace, table_name, row_id)
	) STRICT`);

	return {
		get(address) {
			const row = database
				.query<ReceiptRow, [string, string, string]>(
					`SELECT * FROM folder_receipts
					 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
				)
				.get(address.namespace, address.tableName, address.rowId);
			return row === null ? undefined : toReceipt(row);
		},
		record(receipt) {
			database.run(
				`INSERT INTO folder_receipts (namespace, table_name, row_id, path, fields)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT (namespace, table_name, row_id) DO UPDATE SET
					path = excluded.path,
					fields = excluded.fields`,
				[
					receipt.address.namespace,
					receipt.address.tableName,
					receipt.address.rowId,
					receipt.path,
					JSON.stringify(receipt.fields),
				],
			);
		},
		forget(address) {
			database.run(
				`DELETE FROM folder_receipts
				 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
				[address.namespace, address.tableName, address.rowId],
			);
		},
		all() {
			return database
				.query<ReceiptRow, []>('SELECT * FROM folder_receipts ORDER BY path')
				.all()
				.map(toReceipt);
		},
		close() {
			database.close();
		},
	};
}
