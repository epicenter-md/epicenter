import {
	compile as compileField,
	type Field,
	field as genericField,
	recognize,
	referenceTargetOf,
	storageOf,
} from '@epicenter/field';
import { type Static, type TSchema, Type } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	DATA_ADDRESS_CEILINGS,
	isDatabaseId,
	isTableName,
} from './addresses.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { isJsonValue, type JsonObject, type JsonValue } from './json.js';

export const RESERVED_ATTRIBUTE_PREFIX = '!';
export const KV_ROOT = 'kv';
export const RESERVED_TABLE_NAMES: readonly string[] = [KV_ROOT];

/** A field descriptor as authored or serialized. */
export type FieldDescriptor = object;
export type FieldMap = {
	readonly [field: string]: FieldDescriptor;
};

/** One application's complete, inert data definition. */
export type DataDefinition = {
	readonly id: string;
	readonly title?: string;
	readonly kv: FieldMap;
	readonly tables: {
		readonly [table: string]: FieldMap;
	};
};

/** The JSON representation is the same closed descriptor vocabulary. */
export type DataDefinitionJson = DataDefinition;

type RejectDefault<T> = T extends { default: unknown } ? never : T;
type ValidateFields<T> = {
	[K in keyof T]: T[K] extends TSchema ? RejectDefault<T[K]> : never;
};
type ValidateDefinition<T> = {
	[K in keyof T]: K extends 'tables'
		? T[K] extends Record<string, FieldMap>
			? {
					[N in keyof T[K]]: T[K][N] extends FieldMap
						? ValidateFields<T[K][N]>
						: never;
				}
			: never
		: K extends 'kv'
			? T[K] extends FieldMap
				? ValidateFields<T[K]>
				: never
			: T[K];
};

/** Add data-substrate nullability without teaching the generic field package about it. */
function nullable<S extends TSchema>(
	inner: S,
): TSchema & {
	readonly anyOf: readonly [S, { readonly type: 'null' }];
} {
	return Type.Unsafe<Static<S> | null>({
		anyOf: [inner, { type: 'null' }],
	}) as unknown as TSchema & {
		readonly anyOf: readonly [S, { readonly type: 'null' }];
	};
}

/** The data definition's field namespace. */
export const field = Object.freeze({ ...genericField, nullable });

export type DataField = {
	readonly name: string;
	readonly kind: Field['kind'];
	readonly schema: unknown;
	readonly check: (value: unknown) => boolean;
	readonly nullable: boolean;
	readonly storage: ReturnType<typeof storageOf>;
	readonly reference: string | null;
};

type FieldsOut<TFields> = {
	[K in keyof TFields]: TFields[K] extends TSchema ? Static<TFields[K]> : never;
};

export type RowOf<TFields> = { id: string } & FieldsOut<TFields>;
export type CreateInputOf<TFields> = FieldsOut<TFields>;
export type KvOf<TDatabase extends DataDefinition> = FieldsOut<TDatabase['kv']>;
export type RowsOf<TDatabase extends DataDefinition> = {
	[K in keyof TDatabase['tables']]: RowOf<TDatabase['tables'][K]>;
};
export type CreateInputsOf<TDatabase extends DataDefinition> = {
	[K in keyof TDatabase['tables']]: CreateInputOf<TDatabase['tables'][K]>;
};

export function defineTable<const TFields extends FieldMap>(
	fields: TFields & ValidateFields<TFields>,
): TFields {
	return fields as TFields;
}

export function defineKv<const TFields extends FieldMap>(
	fields: TFields & ValidateFields<TFields>,
): TFields {
	return fields as TFields;
}

export function defineData<const TData extends DataDefinition>(
	data: TData & ValidateDefinition<TData>,
): TData {
	return data as TData;
}

export type ConformanceIssue = { field: string; message: string };

export const DataDefinitionParseError = defineErrors({
	Malformed: ({ reason }: { reason: string }) => ({
		message: `This data definition is not well formed: ${reason}`,
		reason,
	}),
	UnrecognizedField: ({
		table,
		field,
		reason,
	}: {
		table: string;
		field: string;
		reason: string;
	}) => ({
		message: `Field '${table}.${field}' is not recognized vocabulary: ${reason}`,
		table,
		field,
		reason,
	}),
	DeclarationDefault: ({ table, field }: { table: string; field: string }) => ({
		message: `Field '${table}.${field}' declares a default; initialization and recovery belong to the application`,
		table,
		field,
	}),
});
export type DataDefinitionParseError = InferErrors<
	typeof DataDefinitionParseError
>;

export type Conformance = {
	conforming: JsonObject;
	issues: ConformanceIssue[];
};

export type ParsedTable = {
	name: string;
	fields: ReadonlyMap<string, DataField>;
	conformance(payload: JsonObject): Conformance;
	validateWrite(supplied: Record<string, unknown>): Result<JsonObject, never>;
};

export type ParsedDataDefinition = {
	/** The immutable, serialized declaration this compiler result represents. */
	readonly definition: DataDefinition;
	id: string;
	title?: string;
	kv: ParsedTable;
	tables: ReadonlyMap<string, ParsedTable>;
	canonical: string;
};

const parsed = new Map<
	string,
	Result<ParsedDataDefinition, DataDefinitionParseError>
>();

/** Parse and compile one serialized definition, memoized by canonical JSON. */
export function parseData(
	value: unknown,
): Result<ParsedDataDefinition, DataDefinitionParseError> {
	let canonical: string;
	try {
		canonical = canonicalJson(value);
	} catch (cause) {
		return DataDefinitionParseError.Malformed({ reason: String(cause) });
	}
	const key = sha256Hex(canonical);
	const memoised = parsed.get(key);
	if (memoised !== undefined) return memoised;
	const result = compileDefinition(value, canonical);
	parsed.set(key, result);
	return result;
}

function compileDefinition(
	value: unknown,
	canonical: string,
): Result<ParsedDataDefinition, DataDefinitionParseError> {
	if (!isPlainObject(value))
		return DataDefinitionParseError.Malformed({
			reason: 'it is not a plain object',
		});
	const { id, title, kv, tables } = value as Partial<DataDefinition>;
	if (typeof id !== 'string' || !isDatabaseId(id, DATA_ADDRESS_CEILINGS)) {
		return DataDefinitionParseError.Malformed({
			reason: 'it declares an invalid id',
		});
	}
	if (
		title !== undefined &&
		(typeof title !== 'string' || title.trim() === '')
	) {
		return DataDefinitionParseError.Malformed({
			reason: 'its title must say something or be absent',
		});
	}
	if (!isPlainObject(kv))
		return DataDefinitionParseError.Malformed({
			reason: 'it declares no kv section',
		});
	if (!isPlainObject(tables))
		return DataDefinitionParseError.Malformed({
			reason: 'it declares no tables',
		});

	const compiledKvResult = compileTable('kv', kv);
	if (compiledKvResult.error !== null) return compiledKvResult;
	const compiledKv = compiledKvResult.data;
	const compiledTables = new Map<string, ParsedTable>();
	const foldedNames = new Map<string, string>();
	for (const [tableName, fields] of Object.entries(tables)) {
		if (
			!isTableName(tableName, DATA_ADDRESS_CEILINGS) ||
			RESERVED_TABLE_NAMES.includes(tableName)
		) {
			return DataDefinitionParseError.Malformed({
				reason: `table name '${tableName}' is not usable`,
			});
		}
		const folded = tableName.toLowerCase();
		if (foldedNames.has(folded)) {
			return DataDefinitionParseError.Malformed({
				reason: `table names collide case-insensitively: '${tableName}'`,
			});
		}
		foldedNames.set(folded, tableName);
		const result = compileTable(tableName, fields);
		if (result.error !== null) return result;
		compiledTables.set(tableName, result.data);
	}
	const definition = freeze(JSON.parse(canonical) as DataDefinition);
	return Ok(
		Object.freeze({
			definition,
			id,
			...(title === undefined ? {} : { title }),
			kv: compiledKv,
			tables: compiledTables,
			canonical,
		}),
	);
}

function compileTable(
	tableName: string,
	fields: unknown,
): Result<ParsedTable, DataDefinitionParseError> {
	if (!isPlainObject(fields))
		return DataDefinitionParseError.Malformed({
			reason: `table '${tableName}' does not declare fields`,
		});
	const compiled = new Map<string, DataField>();
	for (const [fieldName, descriptor] of Object.entries(fields)) {
		const invalid = fieldNameProblem(tableName, fieldName);
		if (invalid !== undefined) return invalid;
		if (!isPlainObject(descriptor)) {
			return DataDefinitionParseError.UnrecognizedField({
				table: tableName,
				field: fieldName,
				reason: 'a field descriptor must be a JSON object',
			});
		}
		if (containsDefault(descriptor)) {
			return DataDefinitionParseError.DeclarationDefault({
				table: tableName,
				field: fieldName,
			});
		}
		const wire = JSON.parse(JSON.stringify(descriptor)) as Record<
			string,
			unknown
		>;
		const nullableDescriptor = nullableParts(wire);
		const base = recognize(nullableDescriptor?.inner ?? wire);
		if (base === null) {
			return DataDefinitionParseError.UnrecognizedField({
				table: tableName,
				field: fieldName,
				reason: 'expected a closed @epicenter/field descriptor',
			});
		}
		const check = compileField(base.schema);
		compiled.set(fieldName, {
			name: fieldName,
			kind: base.kind,
			schema: wire,
			check:
				nullableDescriptor === null
					? check
					: (value) => value === null || check(value),
			nullable: nullableDescriptor !== null,
			storage: storageOf(base.kind),
			reference: referenceTargetOf({
				...base,
				name: fieldName,
				check,
			} as Field),
		});
	}
	return Ok(
		Object.freeze({
			name: tableName,
			fields: compiled,
			conformance(payload) {
				const conforming: JsonObject = {};
				const issues: ConformanceIssue[] = [];
				for (const [fieldName, field] of compiled) {
					if (!Object.hasOwn(payload, fieldName)) {
						issues.push({
							field: fieldName,
							message: `${fieldName} is missing`,
						});
					} else if (!field.check(payload[fieldName])) {
						issues.push({
							field: fieldName,
							message: `${fieldName} is not a conforming ${field.kind} value`,
						});
					} else {
						conforming[fieldName] = payload[fieldName] as JsonValue;
					}
				}
				return { conforming, issues };
			},
			validateWrite(supplied) {
				const values: JsonObject = {};
				for (const [name, value] of Object.entries(supplied)) {
					if (!isJsonValue(value))
						throw new TypeError(`'${name}' is not finite JSON`);
					values[name] = value;
				}
				return Ok(values);
			},
		}),
	);
}

function nullableParts(
	value: Record<string, unknown>,
): { inner: TSchema } | null {
	if (!Array.isArray(value.anyOf) || value.anyOf.length !== 2) return null;
	const nonNull = value.anyOf.filter((part) => !isNullSchema(part));
	return nonNull.length === 1 && isPlainObject(nonNull[0])
		? { inner: nonNull[0] }
		: null;
}

function isNullSchema(value: unknown): boolean {
	return (
		isPlainObject(value) &&
		value.type === 'null' &&
		Object.keys(value).every((key) => key === 'type')
	);
}

function containsDefault(value: unknown, seen = new Set<object>()): boolean {
	if (!isPlainObject(value) && !Array.isArray(value)) return false;
	if (typeof value === 'object' && value !== null) {
		if (seen.has(value)) return false;
		seen.add(value);
	}
	if (isPlainObject(value) && Object.hasOwn(value, 'default')) return true;
	return Object.values(value).some((child) => containsDefault(child, seen));
}

function fieldNameProblem(
	tableName: string,
	fieldName: string,
): Result<never, DataDefinitionParseError> | undefined {
	if (
		fieldName.startsWith(RESERVED_ATTRIBUTE_PREFIX) ||
		fieldName.toLowerCase() === 'id' ||
		!/^[A-Za-z][A-Za-z0-9_]*$/.test(fieldName)
	) {
		return DataDefinitionParseError.Malformed({
			reason: `field name '${tableName}.${fieldName}' is not usable`,
		});
	}
	return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function freeze<T>(value: T): T {
	if (typeof value !== 'object' || value === null) return value;
	if (Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) freeze(child);
	return Object.freeze(value);
}

/** Test support for a new parse after a definition has changed in-place. */
export function clearDataDefinitionCache(): void {
	parsed.clear();
}
