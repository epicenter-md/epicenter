import type {
	AdoptionResult,
	EpochTransform,
	OverlayImportPlan,
	TableTransform,
	TransitionResult,
} from './epoch-protocol';
import type { Cells, Operation, SnapshotRow } from './protocol';

function rowKey(row: Pick<SnapshotRow, 'table' | 'rowId'>): string {
	return JSON.stringify([row.table, row.rowId]);
}

/**
 * mapIdentity maps ROW identity only. Every input row is live: deleted rows
 * are physically absent from the frozen snapshot the transform reads.
 */
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
			cells: transformCells(row.cells, rule),
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

/**
 * Fresh-incarnation adoption: the destination has zero live rows, so every
 * transformed row streams in as an ordinary createRow mutation. The preflight
 * refuses a mapped-identity collision instead of merging.
 */
export function planAdoption(
	actorId: string,
	source: SnapshotRow[],
	destination: SnapshotRow[],
): AdoptionResult {
	if (destination.length > 0)
		return { ok: false, reason: 'destination-not-empty' };
	const identities = new Set<string>();
	for (const row of source) {
		const key = rowKey(row);
		if (identities.has(key))
			return { ok: false, reason: 'mapped-identity-collision' };
		identities.add(key);
	}
	return {
		ok: true,
		plan: {
			actorId,
			operations: source.map(
				(row): Operation => ({
					kind: 'createRow',
					table: row.table,
					rowId: row.rowId,
					cells: { ...row.cells },
				}),
			),
		},
	};
}

/**
 * Reviewable comparison for a replica importing its private overlay after
 * epoch activation. Equal rows emit nothing and differing cells emit
 * updateRow. Source-only rows are classified by provable pendingness: when
 * the replica's applied cursor equals the frozen head of its old incarnation,
 * its source-only rows are exactly its pending creations and auto-apply as
 * createRow; otherwise they may be upstream deletions from a skipped epoch
 * and are review-required, excluded by default.
 */
export function planOverlayImport(input: {
	actorId: string;
	source: SnapshotRow[];
	destination: SnapshotRow[];
	appliedCursor: number;
	frozenHead: number;
}): OverlayImportPlan {
	const destinationByKey = new Map(
		input.destination.map((row) => [rowKey(row), row]),
	);
	const sourceOnlyIsPendingCreation = input.appliedCursor === input.frozenHead;
	const operations: Operation[] = [];
	const review: SnapshotRow[] = [];
	for (const row of input.source) {
		const current = destinationByKey.get(rowKey(row));
		if (!current) {
			if (sourceOnlyIsPendingCreation)
				operations.push({
					kind: 'createRow',
					table: row.table,
					rowId: row.rowId,
					cells: { ...row.cells },
				});
			else review.push({ ...row, cells: { ...row.cells } });
			continue;
		}
		const cells: Cells = {};
		const fields = new Set([
			...Object.keys(row.cells),
			...Object.keys(current.cells),
		]);
		for (const field of fields) {
			const sourceValue = row.cells[field] ?? null;
			const destinationValue = current.cells[field] ?? null;
			if (sourceValue !== destinationValue) cells[field] = sourceValue;
		}
		if (Object.keys(cells).length > 0)
			operations.push({
				kind: 'updateRow',
				table: row.table,
				rowId: row.rowId,
				cells,
			});
	}
	return { actorId: input.actorId, operations, review };
}

/**
 * Restoring an excluded review row is a NEW identity: it may have been
 * deleted upstream, and a row identity has one lifetime.
 */
export function restoreReviewRowAsNew(
	row: SnapshotRow,
	newRowId: string,
): Operation {
	if (newRowId === row.rowId)
		throw new Error('restored review row must mint a new row identity');
	return {
		kind: 'createRow',
		table: row.table,
		rowId: newRowId,
		cells: { ...row.cells },
	};
}

/** A physical copy adopts through the import door under a fresh actor. */
export function planPhysicalCopyAdoption(
	sourceActorId: string,
	newActorId: string,
	source: SnapshotRow[],
	destination: SnapshotRow[],
): AdoptionResult {
	if (sourceActorId === newActorId)
		throw new Error('physical copy import must mint a new actor');
	return planAdoption(newActorId, source, destination);
}
