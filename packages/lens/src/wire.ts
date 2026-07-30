import type { ValueAddress } from './addresses.js';
import {
	compileTableDefinition,
	compileValueDefinition,
	type TableDefinition,
	type ValueDefinition,
} from './definitions.js';

export type SerializedTableDefinition = {
	namespace: string;
	table: string;
	fields: Record<string, unknown>;
	optionalFields: string[];
};

export type SerializedValueDefinition = {
	address: ValueAddress;
	value: unknown;
};

export function serializeTableDefinition(
	namespace: string,
	tableName: string,
	definition: TableDefinition,
): SerializedTableDefinition {
	const compiled = compileTableDefinition(definition);
	return {
		namespace,
		table: tableName,
		fields: cloneJson(definition.fields),
		optionalFields: [...compiled.optional],
	};
}

export function serializeValueDefinition(
	address: ValueAddress,
	definition: ValueDefinition,
): SerializedValueDefinition {
	compileValueDefinition(definition);
	return { address, value: cloneJson(definition.value) };
}

/**
 * Split a patch into what to write and what to remove.
 *
 * `JSON.stringify` drops a key whose value is `undefined`, so a patch crossing a
 * JSON carrier cannot say "remove this optional field" by holding one. The two
 * halves are named instead, which is also the shape the replica intent already
 * has. Field names are not judged here: the owner of the data owns that and
 * reports it as an ordinary failure, and refusing early would turn a typed
 * decline into a thrown error.
 */
export function splitUpdate(patch: Record<string, unknown>): {
	set: Record<string, unknown>;
	unset: string[];
} {
	const set: Record<string, unknown> = {};
	const unset: string[] = [];
	for (const [name, value] of Object.entries(patch)) {
		if (value === undefined) unset.push(name);
		else set[name] = value;
	}
	return { set, unset };
}

function cloneJson<TValue>(value: TValue): TValue {
	return JSON.parse(JSON.stringify(value)) as TValue;
}
