import type { JsonObject, RecordCommand } from './protocol.js';

export type RowFoldResult =
	| { kind: 'row'; value: JsonObject }
	| { kind: 'deletion' }
	| { kind: 'noop' }
	| { kind: 'create-conflict' };

/** Fold one schema-blind command into one current row lifetime. */
export function foldRow(
	current: JsonObject | undefined,
	command: RecordCommand,
): RowFoldResult {
	switch (command.kind) {
		case 'createRow':
			return current === undefined
				? { kind: 'row', value: structuredClone(command.value) }
				: { kind: 'create-conflict' };
		case 'patchRow': {
			if (current === undefined) return { kind: 'noop' };
			const value = structuredClone(current);
			for (const key of command.unset) delete value[key];
			for (const [key, next] of Object.entries(command.set)) {
				Object.defineProperty(value, key, {
					configurable: true,
					enumerable: true,
					value: structuredClone(next),
					writable: true,
				});
			}
			return { kind: 'row', value };
		}
		case 'deleteRow':
			return current === undefined ? { kind: 'noop' } : { kind: 'deletion' };
	}
}
