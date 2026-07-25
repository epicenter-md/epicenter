import { addressesEqual } from './addresses.js';
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

export function foldChange(
	current: SyncRecord | undefined,
	change: Change,
	nextSequence: number,
): FoldResult {
	const existing =
		current !== undefined && addressesEqual(current.address, change.address)
			? current
			: undefined;
	switch (change.kind) {
		case 'create':
			return existing === undefined
				? applyIfAdmissible(
						{
							kind: 'row',
							address: change.address,
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
							address: change.address,
							changedSequence: nextSequence,
						},
						existing,
					)
				: { kind: 'noop', record: existing };
		case 'set':
			return applyIfAdmissible(
				{
					kind: 'value',
					address: change.address,
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
							address: change.address,
							changedSequence: nextSequence,
						},
						existing,
					)
				: { kind: 'noop', record: existing };
		default:
			return change satisfies never;
	}
}
