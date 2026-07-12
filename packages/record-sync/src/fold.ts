import type { Cells, Operation } from './protocol.js';

/**
 * One deterministic row transition. Absence is the only deleted state: a
 * deleted row is physically gone, and resurrection is prevented by explicit
 * creation plus one-lifetime row ids, not by tombstone records.
 */
export type FoldResult =
	| { kind: 'created'; cells: Cells }
	| { kind: 'updated'; cells: Cells }
	| { kind: 'deleted' }
	| { kind: 'noop' }
	/**
	 * `createRow` named an identity that is already live. Never a routine
	 * no-op: the authority refuses the push and the submitting replica must
	 * discard its state and rebootstrap.
	 */
	| { kind: 'create-conflict' };

/** The total, schema-blind row transition shared by every runtime. */
export function foldRow(
	current: Cells | undefined,
	operation: Operation,
): FoldResult {
	switch (operation.kind) {
		case 'createRow': {
			if (current !== undefined) return { kind: 'create-conflict' };
			const cells: Cells = {};
			for (const [field, value] of Object.entries(operation.cells)) {
				if (value !== null) cells[field] = structuredClone(value);
			}
			return { kind: 'created', cells };
		}
		case 'updateRow': {
			if (current === undefined) return { kind: 'noop' };
			const cells = structuredClone(current);
			for (const [field, value] of Object.entries(operation.cells)) {
				if (value === null) delete cells[field];
				else cells[field] = structuredClone(value);
			}
			return { kind: 'updated', cells };
		}
		case 'deleteRow':
			return current === undefined ? { kind: 'noop' } : { kind: 'deleted' };
	}
}
