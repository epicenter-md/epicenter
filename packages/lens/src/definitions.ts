import { compile, recognize } from '@epicenter/field';
import {
	IsOptional,
	Optional,
	type Static,
	type TOptional,
	type TSchema,
} from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import {
	DATA_ADDRESS_CEILINGS,
	isNamespace,
	isTableName,
	type RowAddress,
} from './addresses.js';
import { isJsonValue, type JsonObject, type JsonValue } from './json.js';

type FieldSchemas = Record<string, TSchema>;

type OptionalFieldNames<TFields extends FieldSchemas> = {
	[K in keyof TFields]: TFields[K] extends TOptional ? K : never;
}[keyof TFields];

type RequiredFieldNames<TFields extends FieldSchemas> = Exclude<
	keyof TFields,
	OptionalFieldNames<TFields>
>;

export type FieldsFor<TFields extends FieldSchemas> = {
	[K in RequiredFieldNames<TFields>]: Static<TFields[K]>;
} & {
	[K in OptionalFieldNames<TFields>]?: Static<TFields[K]>;
};

declare const tableDefinitionParts: unique symbol;
declare const lensParts: unique symbol;

export type TableDefinition<TFields extends FieldSchemas = FieldSchemas> = {
	fields: TFields;
	[tableDefinitionParts]: { fields: TFields };
};

export type TableDefinitions = Record<string, TableDefinition>;

/**
 * One application's complete interpretation of one durable namespace
 * (ADR-0160, ADR-0168, ADR-0206).
 *
 * The namespace is declared exactly once, here. Each `tables` property name is
 * the durable local key for that table: `notes` addresses
 * `{ namespace, tableName: 'notes', rowId }` forever. There is no second `key`
 * field to keep in step with the property name, and no rename operation: a
 * different property name is a different address, and therefore different data.
 *
 * A Lens declares tables and fields and nothing else. A singleton is a row whose
 * id the application chooses, so it needs no second declaration form and no
 * vocabulary of its own.
 *
 * A table name must be a bare SQL identifier, because a trusted host mounts it
 * as a relation (ADR-0162).
 */
export type Lens<TTables extends TableDefinitions = TableDefinitions> = {
	namespace: string;
	tables: TTables;
	[lensParts]: { tables: TTables };
};

export type RowFor<TDefinition extends TableDefinition> =
	TDefinition extends TableDefinition<infer TFields>
		? { id: string } & FieldsFor<TFields>
		: never;

export type CreateInputFor<TDefinition extends TableDefinition> =
	TDefinition extends TableDefinition<infer TFields>
		? FieldsFor<TFields> & { id?: never }
		: never;

export type ConstrainedUpdate<
	TDefinition extends TableDefinition,
	TChanges extends Record<string, unknown>,
> =
	TDefinition extends TableDefinition<infer TFields>
		? Record<Exclude<keyof TChanges, keyof TFields>, never> & {
				[K in keyof TChanges]: K extends keyof TFields
					? K extends OptionalFieldNames<TFields>
						? Static<TFields[K]> | undefined
						: Static<TFields[K]>
					: never;
			}
		: never;

export type ConformanceIssue = {
	field: string;
	kind: 'missing' | 'invalid';
	message: string;
};

export const DataReadError = defineErrors({
	NonconformingRow: ({
		address,
		raw,
		issues,
	}: {
		address: RowAddress;
		raw: JsonObject;
		issues: readonly ConformanceIssue[];
	}) => ({
		message: `Stored row '${address.namespace}/${address.tableName}/${address.rowId}' does not satisfy the current definition`,
		address,
		/** The structural row id, which is also `address.rowId`. */
		id: address.rowId,
		raw,
		issues,
	}),
});
export type DataReadError = InferErrors<typeof DataReadError>;
export type NonconformingRowError = Extract<
	DataReadError,
	{ name: 'NonconformingRow' }
>;

type CompiledField = {
	check(value: unknown): boolean;
};

export type NormalizedUpdate = {
	set: JsonObject;
	unset: string[];
};

export type CompiledTableDefinition = {
	fields: ReadonlyMap<string, CompiledField>;
	optional: ReadonlySet<string>;
	project(
		address: RowAddress,
		payload: JsonObject,
	): Result<Record<string, unknown>, NonconformingRowError>;
	validateCreate(input: Record<string, unknown>): JsonObject;
	normalizeUpdate(input: Record<string, unknown>): NormalizedUpdate;
};

const compiledTables = new WeakMap<object, CompiledTableDefinition>();

/**
 * Mark one field as optional in a table definition.
 *
 * Annotated as `TOptional<T>` rather than TypeBox's own `TOptionalAdd<T>`,
 * which is what `Optional()` actually returns. The two agree for every schema
 * this can be handed (`TOptionalAdd` only differs when the schema is already
 * optional, and marking twice yields the same intersection), and `TOptional` is
 * the name that has stayed exported across TypeBox 1.x. This package's `.d.ts`
 * is compiled and published, so a consumer type-checks it against whatever
 * TypeBox their own install resolved: naming a type that moved between minor
 * versions turns our upgrade into their build failure.
 */
export function optional<TSchemaValue extends TSchema>(
	schema: TSchemaValue,
): TOptional<TSchemaValue> {
	return Optional(schema) as TOptional<TSchemaValue>;
}

export function defineTable<const TFields extends FieldSchemas>({
	fields: fieldsInput,
}: {
	fields: TFields & { id?: never };
}): TableDefinition<TFields> {
	assertPlainObject(fieldsInput, 'Table fields');
	if (Object.keys(fieldsInput).some((name) => name.toLowerCase() === 'id')) {
		throw new Error(
			"Table definitions cannot declare the structural 'id' field",
		);
	}
	assertNoCaseInsensitiveDuplicates(Object.keys(fieldsInput), 'field');

	const fields: FieldSchemas = {};
	const compiledFields = new Map<string, CompiledField>();
	const optionalFields = new Set<string>();
	for (const [name, authoredSchema] of Object.entries(fieldsInput)) {
		assertFieldName(name);
		const schema = cloneSchema(authoredSchema);
		const recognized = recognize(schema);
		if (recognized === null) {
			throw new Error(`Field '${name}' must use the field.* vocabulary`);
		}
		fields[name] = freezeJson(schema);
		compiledFields.set(name, { check: compile(recognized.schema) });
		if (IsOptional(authoredSchema)) optionalFields.add(name);
	}

	const definition = Object.freeze({
		fields: Object.freeze(fields),
	}) as TableDefinition<TFields>;
	compiledTables.set(
		definition,
		createCompiledTable(compiledFields, optionalFields),
	);
	return definition;
}

/**
 * Declare one application's interpretation of one durable namespace.
 *
 * Every table name must be usable as a SQL identifier, because a trusted
 * inspection host mounts a selected Lens as logical relations named exactly
 * after these properties (ADR-0162). SQL identifiers are case-insensitive, so
 * two names differing only in case are refused here rather than colliding later
 * at mount time.
 */
export function defineLens<const TTables extends TableDefinitions>({
	namespace,
	tables,
}: {
	namespace: string;
	tables: TTables;
}): Lens<TTables> {
	if (!isNamespace(namespace, DATA_ADDRESS_CEILINGS)) {
		throw new Error(
			`Invalid namespace '${namespace}'; use two or more lowercase dot-separated labels`,
		);
	}
	assertPlainObject(tables, 'Lens tables');
	for (const [name, definition] of Object.entries(tables)) {
		assertTableName(name);
		compileTableDefinition(definition);
	}
	assertNoCaseInsensitiveDuplicates(Object.keys(tables), 'table');
	return Object.freeze({
		namespace,
		tables: Object.freeze(tables),
	}) as Lens<TTables>;
}

export function compileTableDefinition(
	definition: TableDefinition,
): CompiledTableDefinition {
	const compiled = compiledTables.get(definition);
	if (compiled === undefined) throw new Error('Unknown table definition');
	return compiled;
}

function createCompiledTable(
	fields: ReadonlyMap<string, CompiledField>,
	optionalFields: ReadonlySet<string>,
): CompiledTableDefinition {
	return {
		fields,
		optional: optionalFields,
		project(address, payload) {
			const projected: Record<string, unknown> = { id: address.rowId };
			const issues: ConformanceIssue[] = [];
			for (const [name, field] of fields) {
				if (!Object.hasOwn(payload, name)) {
					if (!optionalFields.has(name)) {
						issues.push({
							field: name,
							kind: 'missing',
							message: `Missing required field '${name}'`,
						});
					}
					continue;
				}
				const value = payload[name];
				if (!field.check(value)) {
					issues.push({
						field: name,
						kind: 'invalid',
						message: `Field '${name}' is invalid`,
					});
					continue;
				}
				projected[name] = cloneJsonValue(value);
			}
			return issues.length === 0
				? Ok(projected)
				: DataReadError.NonconformingRow({
						address,
						raw: cloneJsonValue(payload),
						issues,
					});
		},
		validateCreate(input) {
			assertPlainObject(input, 'Create input');
			const payload: JsonObject = {};
			for (const name of Object.keys(input)) {
				if (!fields.has(name)) throw new Error(`Unknown field '${name}'`);
			}
			for (const [name, field] of fields) {
				if (!Object.hasOwn(input, name) || input[name] === undefined) {
					if (!optionalFields.has(name)) {
						throw new Error(`Missing required field '${name}'`);
					}
					continue;
				}
				const value = input[name];
				if (!field.check(value)) throw new TypeError(`Invalid field '${name}'`);
				payload[name] = cloneJsonValue(value);
			}
			return payload;
		},
		normalizeUpdate(input) {
			assertPlainObject(input, 'Update input');
			const set: JsonObject = {};
			const unset: string[] = [];
			for (const [name, value] of Object.entries(input)) {
				const field = fields.get(name);
				if (field === undefined) throw new Error(`Unknown field '${name}'`);
				if (value === undefined) {
					if (!optionalFields.has(name)) {
						throw new TypeError(`Required field '${name}' cannot be unset`);
					}
					unset.push(name);
					continue;
				}
				if (!field.check(value)) throw new TypeError(`Invalid field '${name}'`);
				set[name] = cloneJsonValue(value);
			}
			return { set, unset };
		},
	};
}

function assertTableName(name: string): void {
	if (!isTableName(name, DATA_ADDRESS_CEILINGS)) {
		throw new Error(
			`Invalid table name '${name}'; start with a letter and use letters, digits, and underscores, because a table name is mounted as a SQL relation`,
		);
	}
}

function assertNoCaseInsensitiveDuplicates(
	names: readonly string[],
	label: 'table' | 'field',
): void {
	const seen = new Map<string, string>();
	for (const name of names) {
		const folded = name.toLowerCase();
		const existing = seen.get(folded);
		if (existing !== undefined) {
			throw new Error(
				`Ambiguous ${label} names '${existing}' and '${name}' differ only by case`,
			);
		}
		seen.set(folded, name);
	}
}

function assertFieldName(name: string): void {
	if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(
			`Invalid field name '${name}'; use letters, digits, and underscores`,
		);
	}
}

function assertPlainObject(
	value: unknown,
	label: string,
): asserts value is Record<string, unknown> {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	) {
		throw new TypeError(`${label} must be a plain object`);
	}
}

function cloneSchema<TSchemaValue extends TSchema>(
	schema: TSchemaValue,
): TSchemaValue {
	return JSON.parse(JSON.stringify(schema)) as TSchemaValue;
}

function freezeJson<TValue>(value: TValue): TValue {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value)) freezeJson(child);
	return Object.freeze(value);
}

function cloneJsonValue(value: JsonObject): JsonObject;
function cloneJsonValue(value: JsonValue): JsonValue;
function cloneJsonValue(value: unknown): JsonValue;
function cloneJsonValue(value: unknown): JsonValue {
	if (!isJsonValue(value)) throw new TypeError('Value must be finite JSON');
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map(cloneJsonValue);
	const clone: JsonObject = {};
	for (const [key, child] of Object.entries(value)) {
		clone[key] = cloneJsonValue(child);
	}
	return clone;
}
