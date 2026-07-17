import { compile, type Kind, recognize } from '@epicenter/field';
import type { Static, TSchema } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

type FieldSchemas = Readonly<Record<string, TSchema>>;

declare const tableLensParts: unique symbol;

/** A release-local interpretation of schema-opaque canonical records. */
export type TableLensDefinition<
	TFields extends FieldSchemas = FieldSchemas,
	TOptional extends readonly (keyof TFields &
		string)[] = readonly (keyof TFields & string)[],
> = {
	fields: Readonly<TFields>;
	optional: TOptional;
	[tableLensParts]: { fields: TFields; optional: TOptional };
};

export type TableLensDefinitions = Readonly<
	Record<string, TableLensDefinition>
>;

type PartsOf<TDefinition> =
	TDefinition extends TableLensDefinition<infer TFields, infer TOptional>
		? { fields: TFields; optional: TOptional }
		: never;

type RequiredFieldNames<
	TFields extends FieldSchemas,
	TOptional extends readonly (keyof TFields & string)[],
> = Exclude<keyof TFields, TOptional[number]>;

type ProjectedFields<
	TFields extends FieldSchemas,
	TOptional extends readonly (keyof TFields & string)[],
> = {
	[K in RequiredFieldNames<TFields, TOptional>]: Static<TFields[K]>;
} & {
	[K in TOptional[number]]?: Static<TFields[K]>;
};

/** The row shape successfully projected through one table lens. */
export type RowFor<TDefinition extends TableLensDefinition> = {
	id: string;
} & ProjectedFields<
	PartsOf<TDefinition>['fields'],
	PartsOf<TDefinition>['optional']
>;

/** Input for creating a row. Identity is always allocated by the runtime. */
export type CreateInputFor<TDefinition extends TableLensDefinition> =
	ProjectedFields<
		PartsOf<TDefinition>['fields'],
		PartsOf<TDefinition>['optional']
	> & { id?: never };

/**
 * Restrict update changes to declared fields while allowing `undefined` only for
 * optional fields, where it means unset.
 */
export type ConstrainedChanges<
	TDefinition extends TableLensDefinition,
	TChanges extends Record<string, unknown>,
> = Record<
	Exclude<keyof TChanges, keyof PartsOf<TDefinition>['fields']>,
	never
> & {
	[K in keyof TChanges]: K extends keyof PartsOf<TDefinition>['fields']
		? K extends PartsOf<TDefinition>['optional'][number]
			? Static<PartsOf<TDefinition>['fields'][K]> | undefined
			: Static<PartsOf<TDefinition>['fields'][K]>
		: never;
};

export type RecordLensIssue = {
	field: string;
	kind: 'missing' | 'invalid';
	message: string;
};

export const RecordLensError = defineErrors({
	NonconformingRecord: ({
		table,
		id,
		raw,
		issues,
	}: {
		table: string;
		id: string;
		raw: JsonObject;
		issues: readonly RecordLensIssue[];
	}) => ({
		message: `Canonical row '${table}.${id}' does not satisfy the current lens`,
		table,
		id,
		raw,
		issues,
	}),
});
export type RecordLensError = InferErrors<typeof RecordLensError>;

type CompiledLensField = {
	name: string;
	kind: Kind;
	check(value: unknown): boolean;
};

type NormalizedChanges = {
	set: JsonObject;
	unset: string[];
};

/** Runtime validation and projection owned by one immutable lens definition. */
type CompiledTableLens = {
	fields: ReadonlyMap<string, CompiledLensField>;
	optional: ReadonlySet<string>;
	project(
		table: string,
		id: string,
		payload: JsonObject,
	): Result<Record<string, unknown>, RecordLensError>;
	validateCreate(input: Record<string, unknown>): JsonObject;
	normalizeChanges(changes: Record<string, unknown>): NormalizedChanges;
};

const compiledLenses = new WeakMap<object, CompiledTableLens>();

/**
 * Define a release-local validation and projection lens.
 *
 * Field names are permanent storage keys. `id` is structural and cannot be
 * declared. Fields are required for interpretation unless listed as optional.
 */
export function defineTable<const TFields extends FieldSchemas>(config: {
	fields: TFields & { id?: never };
}): TableLensDefinition<TFields, readonly []>;
export function defineTable<
	const TFields extends FieldSchemas,
	const TOptional extends readonly (keyof TFields & string)[],
>(config: {
	fields: TFields & { id?: never };
	optional: TOptional;
}): TableLensDefinition<TFields, TOptional>;
export function defineTable({
	fields: fieldsInput,
	optional: optionalInput,
}: {
	fields: FieldSchemas & { id?: never };
	optional?: readonly string[];
}): TableLensDefinition {
	assertPlainObject(fieldsInput, 'table fields');
	if (Object.keys(fieldsInput).some((name) => name.toLowerCase() === 'id')) {
		throw new Error("Table lenses cannot declare the structural 'id' field");
	}

	const sqliteNames = new Set<string>();
	const fields = Object.freeze(
		Object.fromEntries(
			Object.entries(fieldsInput).map(([name, schema]) => {
				assertLensName(name, 'field name');
				const sqliteName = name.toLowerCase();
				if (sqliteNames.has(sqliteName)) {
					throw new Error(
						`Field '${name}' collides with another field in SQLite`,
					);
				}
				sqliteNames.add(sqliteName);
				return [name, freezeJson(cloneSchema(schema))];
			}),
		),
	) as FieldSchemas;
	const optional = Object.freeze([...(optionalInput ?? [])]);
	const optionalSet = new Set<string>();
	for (const name of optional) {
		if (!Object.hasOwn(fields, name)) {
			throw new Error(`Optional field '${name}' is not declared`);
		}
		if (optionalSet.has(name)) {
			throw new Error(`Optional field '${name}' is listed twice`);
		}
		optionalSet.add(name);
	}

	const compiledFields = new Map<string, CompiledLensField>();
	for (const [name, schema] of Object.entries(fields)) {
		const recognized = recognize(schema);
		if (!recognized) {
			throw new Error(`Field '${name}' must use the field.* vocabulary`);
		}
		const check = compile(recognized.schema);
		compiledFields.set(name, {
			name,
			kind: recognized.kind,
			check(value) {
				return isJsonValue(value) && check(value);
			},
		});
	}

	const definition = Object.freeze({
		fields,
		optional,
	}) as TableLensDefinition;
	compiledLenses.set(
		definition,
		createCompiledLens(compiledFields, optionalSet),
	);
	return definition;
}

/** Package-internal bridge from an inert definition to its compiled lens. */
export function compileTableLens(
	definition: TableLensDefinition,
): CompiledTableLens {
	const compiled = compiledLenses.get(definition);
	if (!compiled) throw new Error('Unknown table lens definition');
	return compiled;
}

function createCompiledLens(
	fields: ReadonlyMap<string, CompiledLensField>,
	optional: ReadonlySet<string>,
): CompiledTableLens {
	return Object.freeze({
		fields,
		optional,
		project(table: string, id: string, payload: JsonObject) {
			const row: Record<string, unknown> = { id };
			const issues: RecordLensIssue[] = [];
			for (const [name, field] of fields) {
				if (!Object.hasOwn(payload, name)) {
					if (!optional.has(name)) {
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
				row[name] = cloneJsonValue(value);
			}
			return issues.length === 0
				? Ok(row)
				: RecordLensError.NonconformingRecord({
						table,
						id,
						raw: cloneJsonObject(payload),
						issues: structuredClone(issues),
					});
		},
		validateCreate(input: Record<string, unknown>) {
			assertPlainObject(input, 'create input');
			const payload: JsonObject = {};
			for (const name of Object.keys(input)) {
				if (!fields.has(name)) throw new Error(`Unknown field '${name}'`);
			}
			for (const [name, field] of fields) {
				if (!Object.hasOwn(input, name) || input[name] === undefined) {
					if (!optional.has(name)) {
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
		normalizeChanges(changes: Record<string, unknown>) {
			assertPlainObject(changes, 'update changes');
			const set: JsonObject = {};
			const unset: string[] = [];
			for (const [name, value] of Object.entries(changes)) {
				const field = fields.get(name);
				if (!field) throw new Error(`Unknown field '${name}'`);
				if (value === undefined) {
					if (!optional.has(name)) {
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
	});
}

function cloneJsonObject(value: JsonObject): JsonObject {
	return structuredClone(value);
}

function cloneJsonValue(value: unknown): JsonValue {
	if (!isJsonValue(value)) throw new TypeError('Value must be finite JSON');
	return structuredClone(value);
}

function isJsonValue(
	value: unknown,
	ancestors = new Set<object>(),
): value is JsonValue {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return true;
	}
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object' || ancestors.has(value)) return false;
	ancestors.add(value);
	const valid = Array.isArray(value)
		? value.every((item) => isJsonValue(item, ancestors))
		: isPlainObject(value) &&
			Object.values(value).every((item) => isJsonValue(item, ancestors));
	ancestors.delete(value);
	return valid;
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

function assertPlainObject(
	value: unknown,
	label: string,
): asserts value is Record<string, unknown> {
	if (!isPlainObject(value))
		throw new TypeError(`${label} must be a plain object`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertLensName(value: string, label: string): void {
	if (
		!/^[A-Za-z][A-Za-z0-9_]*$/.test(value) ||
		value.startsWith('__epicenter_')
	) {
		throw new Error(
			`Invalid ${label} '${value}'; use letters, digits, and underscores and do not use the internal prefix`,
		);
	}
}
