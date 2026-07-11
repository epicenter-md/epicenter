import type {
	EpochTransform,
	ImportPlan,
	TableTransform,
	TransitionResult,
} from './epoch-protocol';
import type { Cells, Operation, SnapshotRow } from './protocol';

function rowKey(row: Pick<SnapshotRow, 'table' | 'rowId'>): string {
	return JSON.stringify([row.table, row.rowId]);
}

export function transformRows(
	rows: SnapshotRow[],
	transform: EpochTransform,
): { result: TransitionResult; rows: SnapshotRow[] } {
	const rules = new Map(
		transform.tables.map((rule) => [rule.sourceTable, rule]),
	);
	const output: SnapshotRow[] = [];
	const identities = new Set<string>();
	for (const row of rows) {
		const rule = rules.get(row.table);
		if (!rule)
			return {
				result: { ok: false, reason: 'missing-table-transform' },
				rows: [],
			};
		if (rule.destinations.length > 1)
			return {
				result: { ok: false, reason: 'one-to-many-identity' },
				rows: [],
			};
		const destination = rule.destinations[0];
		if (!destination) continue;
		const rowId =
			destination.rowId === 'preserve' ? row.rowId : destination.rowId.constant;
		const key = JSON.stringify([destination.table, rowId]);
		if (identities.has(key))
			return {
				result: { ok: false, reason: 'many-to-one-identity' },
				rows: [],
			};
		identities.add(key);
		output.push({
			table: destination.table,
			rowId,
			deleted: row.deleted,
			cells: row.deleted ? {} : transformCells(row.cells, rule),
		});
	}
	return {
		result: { ok: true },
		rows: output.sort((left, right) =>
			rowKey(left).localeCompare(rowKey(right)),
		),
	};
}

function transformCells(cells: Cells, rule: TableTransform): Cells {
	const transformed: Cells = { ...rule.defaults };
	for (const [field, value] of Object.entries(cells)) {
		const target = Object.hasOwn(rule.fields, field)
			? rule.fields[field]
			: field;
		if (target !== null) transformed[target] = value;
	}
	return transformed;
}

export function planImport(
	actorId: string,
	source: SnapshotRow[],
	destination: SnapshotRow[],
): ImportPlan {
	const destinationByKey = new Map(
		destination.map((row) => [rowKey(row), row]),
	);
	const operations: Operation[] = [];
	for (const row of source) {
		const current = destinationByKey.get(rowKey(row));
		if (row.deleted) {
			if (!current?.deleted)
				operations.push({
					kind: 'deleteRow',
					table: row.table,
					rowId: row.rowId,
				});
			continue;
		}
		if (current?.deleted) continue;
		const cells: Cells = {};
		const fields = new Set([
			...Object.keys(row.cells),
			...Object.keys(current?.cells ?? {}),
		]);
		for (const field of fields) {
			const sourceValue = row.cells[field] ?? null;
			const destinationValue = current?.cells[field] ?? null;
			if (sourceValue !== destinationValue) cells[field] = sourceValue;
		}
		if (!current || Object.keys(cells).length > 0)
			operations.push({
				kind: 'patchRow',
				table: row.table,
				rowId: row.rowId,
				cells: current ? cells : { ...row.cells },
			});
	}
	return { actorId, operations };
}

export function planPhysicalCopyImport(
	sourceActorId: string,
	newActorId: string,
	source: SnapshotRow[],
	destination: SnapshotRow[],
): ImportPlan {
	if (sourceActorId === newActorId)
		throw new Error('physical copy import must mint a new actor');
	return planImport(newActorId, source, destination);
}
