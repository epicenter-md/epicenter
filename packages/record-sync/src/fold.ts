import type { Cells, Operation } from './protocol.js';

export type LogicalRow = { kind: 'live'; cells: Cells } | { kind: 'tombstone' };

/** The total, schema-blind row transition shared by every runtime. */
export function foldRow(
	row: LogicalRow | undefined,
	operation: Operation,
): LogicalRow {
	if (operation.kind === 'deleteRow') return { kind: 'tombstone' };
	if (row?.kind === 'tombstone') return row;
	const cells = structuredClone(row?.cells ?? {});
	for (const [field, value] of Object.entries(operation.cells)) {
		if (value === null) delete cells[field];
		else cells[field] = structuredClone(value);
	}
	return { kind: 'live', cells };
}
