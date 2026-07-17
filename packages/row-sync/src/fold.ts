import {
	encodedJsonBytes,
	isAdmissibleJsonObject,
	isReservedKvAddress,
	ROW_SYNC_ADMISSION_LIMITS,
} from './admission.js';
import type { JsonObject, WireRowIntent } from './protocol.js';

/**
 * The scalar component of one intent folded against one current row. The
 * document component folds separately at the authority (ADR-0131: field and
 * document components of a live-row update are independent laws).
 */
export type FieldsFoldResult =
	| { kind: 'fields'; fields: JsonObject }
	| { kind: 'deletion' }
	| { kind: 'noop' };

/**
 * Fold one schema-blind RowIntent's field component into one current row.
 * This is the mirror rule (ADR-0131): the authority folds every accepted
 * intent with it and every replica projects pending intent with it, so both
 * sides reach the same application or the same deterministic no-op. Nothing
 * here refuses:
 *
 * - `create` on a live row is a no-op; first create wins.
 * - `update` on an absent row is a no-op, except at the reserved KV address
 *   (ADR-0132), where it folds from `{}`.
 * - A folded row that exceeds its capacity cap (the general row cap, or the
 *   KV aggregate cap at the reserved address) is a no-op.
 * - `delete` on an absent row is a no-op; deletion is permanent.
 * - A document-only `update` leaves fields untouched (`noop` here); its
 *   liveness rule is the caller's, because absence no-ops the whole intent.
 */
export function foldFields(
	current: JsonObject | undefined,
	intent: WireRowIntent,
): FieldsFoldResult {
	switch (intent.kind) {
		case 'create':
			return current === undefined && fitsCapacity(intent, intent.fields)
				? { kind: 'fields', fields: structuredClone(intent.fields) }
				: { kind: 'noop' };
		case 'update': {
			if (intent.fields === undefined) return { kind: 'noop' };
			const base =
				current ??
				(isReservedKvAddress(intent.table, intent.rowId) ? {} : undefined);
			if (base === undefined) return { kind: 'noop' };
			const fields = structuredClone(base);
			for (const key of intent.fields.unset) delete fields[key];
			for (const [key, next] of Object.entries(intent.fields.set)) {
				Object.defineProperty(fields, key, {
					configurable: true,
					enumerable: true,
					value: structuredClone(next),
					writable: true,
				});
			}
			return fitsCapacity(intent, fields)
				? { kind: 'fields', fields }
				: { kind: 'noop' };
		}
		case 'delete':
			return current === undefined ? { kind: 'noop' } : { kind: 'deletion' };
	}
}

/**
 * The capacity fold rule. No compositionally closed local bound exists for
 * schema-blind set/unset composition, so the cap is enforced where
 * composition happens: at fold time, deterministically, on both sides.
 */
function fitsCapacity(
	intent: { table: string; rowId: string },
	fields: JsonObject,
): boolean {
	if (!isAdmissibleJsonObject(fields)) return false;
	if (isReservedKvAddress(intent.table, intent.rowId)) {
		return (
			encodedJsonBytes(fields) <=
			ROW_SYNC_ADMISSION_LIMITS.encodedKvAggregateBytes
		);
	}
	return (
		encodedJsonBytes({
			table: intent.table,
			rowId: intent.rowId,
			fields,
			sequence: Number.MAX_SAFE_INTEGER,
		}) <= ROW_SYNC_ADMISSION_LIMITS.encodedRowBytes
	);
}
