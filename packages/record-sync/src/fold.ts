import {
	encodedJsonBytes,
	isAdmissibleJsonObject,
	isReservedKvAddress,
	RECORD_SYNC_ADMISSION_LIMITS,
} from './admission.js';
import type { JsonObject, RecordCommand } from './protocol.js';

/** The row-state commands; `bodyAppend` folds into a row's body log instead. */
export type RowCommand = Exclude<RecordCommand, { kind: 'bodyAppend' }>;

export type RowFoldResult =
	| { kind: 'row'; value: JsonObject }
	| { kind: 'deletion' }
	| { kind: 'noop' };

/**
 * Fold one schema-blind command into one current row. This is the mirror rule
 * (ADR-0131): the authority folds every accepted command with it and every
 * replica replays pending intent with it, so both sides reach the same
 * application or the same deterministic no-op. Nothing here refuses:
 *
 * - `createRow` on a live row is a no-op; first create wins.
 * - `patchRow` on an absent row is a no-op, except at the reserved KV address
 *   (ADR-0132), where it folds from `{}`.
 * - A folded row that exceeds its capacity cap (the general row cap, or the
 *   KV aggregate cap at the reserved address) is a no-op.
 * - `deleteRow` on an absent row is a no-op; deletion is permanent.
 */
export function foldRow(
	current: JsonObject | undefined,
	command: RowCommand,
): RowFoldResult {
	switch (command.kind) {
		case 'createRow':
			return current === undefined && fitsCapacity(command, command.value)
				? { kind: 'row', value: structuredClone(command.value) }
				: { kind: 'noop' };
		case 'patchRow': {
			const base =
				current ??
				(isReservedKvAddress(command.table, command.rowId) ? {} : undefined);
			if (base === undefined) return { kind: 'noop' };
			const value = structuredClone(base);
			for (const key of command.unset) delete value[key];
			for (const [key, next] of Object.entries(command.set)) {
				Object.defineProperty(value, key, {
					configurable: true,
					enumerable: true,
					value: structuredClone(next),
					writable: true,
				});
			}
			return fitsCapacity(command, value)
				? { kind: 'row', value }
				: { kind: 'noop' };
		}
		case 'deleteRow':
			return current === undefined ? { kind: 'noop' } : { kind: 'deletion' };
	}
}

/**
 * The capacity fold rule. No compositionally closed local bound exists for
 * schema-blind patch composition, so the cap is enforced where composition
 * happens: at fold time, deterministically, on both sides.
 */
function fitsCapacity(
	command: { table: string; rowId: string },
	value: JsonObject,
): boolean {
	if (!isAdmissibleJsonObject(value)) return false;
	if (isReservedKvAddress(command.table, command.rowId)) {
		return (
			encodedJsonBytes(value) <=
			RECORD_SYNC_ADMISSION_LIMITS.encodedKvAggregateBytes
		);
	}
	return (
		encodedJsonBytes({
			table: command.table,
			rowId: command.rowId,
			value,
			lastServerSequence: Number.MAX_SAFE_INTEGER,
		}) <= RECORD_SYNC_ADMISSION_LIMITS.encodedRowBytes
	);
}
