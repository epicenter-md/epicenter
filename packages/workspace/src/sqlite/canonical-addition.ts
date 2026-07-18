import {
	type JsonObject,
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
	type WireRowIntent,
} from '@epicenter/row-sync';
import type { SqliteDatabase } from '@epicenter/sqlite';
import {
	readLocalDocumentParts,
	readLocalRow,
} from './local-workspace-storage.js';

export type LogicalWorkspaceRow = {
	table: string;
	rowId: string;
	fields: JsonObject;
	document?: Uint8Array;
};

/** Portable user content. It deliberately contains no synchronization state. */
export type LogicalWorkspaceCopy = {
	rows: LogicalWorkspaceRow[];
	kv: JsonObject;
};

export function captureLogicalWorkspace({
	addresses,
	readCurrentRow,
	readCurrentDocumentParts,
	mergeUpdates,
}: {
	addresses: readonly { table: string; rowId: string }[];
	readCurrentRow(table: string, rowId: string): JsonObject | undefined;
	readCurrentDocumentParts?(table: string, rowId: string): Uint8Array[];
	mergeUpdates?(parts: readonly Uint8Array[]): Uint8Array;
}): LogicalWorkspaceCopy {
	const rows: LogicalWorkspaceRow[] = [];
	let kv: JsonObject = {};
	for (const { table, rowId } of addresses) {
		const fields = readCurrentRow(table, rowId);
		if (fields === undefined) continue;
		if (table === RESERVED_KV_TABLE && rowId === RESERVED_KV_ROW_ID) {
			kv = structuredClone(fields);
			continue;
		}
		const parts = readCurrentDocumentParts?.(table, rowId) ?? [];
		rows.push({
			table,
			rowId,
			fields: structuredClone(fields),
			...(parts.length === 0 || mergeUpdates === undefined
				? {}
				: { document: mergeUpdates(parts) }),
		});
	}
	return { rows, kv };
}

/** Admit a logical copy as ordinary new work in its destination replica. */
export function logicalWorkspaceIntents(
	copy: LogicalWorkspaceCopy,
): WireRowIntent[] {
	const intents: WireRowIntent[] = [];
	for (const row of copy.rows) {
		intents.push({
			kind: 'create',
			table: row.table,
			rowId: row.rowId,
			fields: structuredClone(row.fields),
		});
	}
	if (Object.keys(copy.kv).length === 0) return intents;
	intents.push({
		kind: 'update',
		table: RESERVED_KV_TABLE,
		rowId: RESERVED_KV_ROW_ID,
		fields: { set: structuredClone(copy.kv), unset: [] },
	});
	return intents;
}

export function captureLocalWorkspace(
	source: SqliteDatabase,
	mergeUpdates: (parts: readonly Uint8Array[]) => Uint8Array,
): LogicalWorkspaceCopy {
	const addresses = source.all<{ table: string; rowId: string }>(
		`SELECT table_key AS "table", row_id AS "rowId" FROM "rows"
		 ORDER BY table_key, row_id`,
	);
	return captureLogicalWorkspace({
		addresses,
		readCurrentRow: (table, rowId) => readLocalRow(source, table, rowId),
		readCurrentDocumentParts: (table, rowId) =>
			readLocalDocumentParts(source, table, rowId),
		mergeUpdates,
	});
}

/** Delete only logical content from a local Device workspace. */
export function deleteLocalWorkspace(sqlite: SqliteDatabase): void {
	sqlite.transaction(() => {
		sqlite.run('DELETE FROM "documents"');
		sqlite.run('DELETE FROM "rows"');
	});
}
