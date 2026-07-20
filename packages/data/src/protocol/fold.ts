import { isAdmissibleRecord } from './admission.js';
import type { Change, JsonObject, Record as SyncRecord } from './schemas.js';

export type FoldResult =
	| { kind: 'applied'; record: SyncRecord }
	| { kind: 'noop'; record: SyncRecord | undefined };

function applyIfAdmissible(
	record: SyncRecord,
	current: SyncRecord | undefined,
): FoldResult {
	return isAdmissibleRecord({
		...record,
		changedSequence: Number.MAX_SAFE_INTEGER,
	})
		? { kind: 'applied', record }
		: { kind: 'noop', record: current };
}

function sameAddress(current: SyncRecord | undefined, change: Change): boolean {
	if (current === undefined || current.key !== change.key) return false;
	return 'rowId' in change
		? 'rowId' in current && current.rowId === change.rowId
		: !('rowId' in current);
}

export function foldChange(
	current: SyncRecord | undefined,
	change: Change,
	nextSequence: number,
): FoldResult {
	const existing = sameAddress(current, change) ? current : undefined;
	switch (change.kind) {
		case 'create':
			return existing === undefined
				? applyIfAdmissible(
						{
							kind: 'row',
							key: change.key,
							rowId: change.rowId,
							changedSequence: nextSequence,
							fields: structuredClone(change.fields),
						},
						existing,
					)
				: { kind: 'noop', record: existing };
		case 'update': {
			if (existing?.kind !== 'row') return { kind: 'noop', record: existing };
			const fields: JsonObject = structuredClone(existing.fields);
			for (const [key, value] of Object.entries(change.fields.set)) {
				Object.defineProperty(fields, key, {
					configurable: true,
					enumerable: true,
					value: structuredClone(value),
					writable: true,
				});
			}
			for (const key of change.fields.unset) delete fields[key];
			return applyIfAdmissible(
				{ ...existing, changedSequence: nextSequence, fields },
				existing,
			);
		}
		case 'delete':
			return existing?.kind === 'row'
				? applyIfAdmissible(
						{
							kind: 'row-deleted',
							key: change.key,
							rowId: change.rowId,
							changedSequence: nextSequence,
						},
						existing,
					)
				: { kind: 'noop', record: existing };
		case 'set':
			return applyIfAdmissible(
				{
					kind: 'value',
					key: change.key,
					changedSequence: nextSequence,
					value: structuredClone(change.value),
				},
				existing,
			);
		case 'unset':
			return existing?.kind === 'value'
				? applyIfAdmissible(
						{
							kind: 'value-unset',
							key: change.key,
							changedSequence: nextSequence,
						},
						existing,
					)
				: { kind: 'noop', record: existing };
		default:
			return change satisfies never;
	}
}
