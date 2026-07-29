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

function cloneJson<TValue>(value: TValue): TValue {
	return JSON.parse(JSON.stringify(value)) as TValue;
}
