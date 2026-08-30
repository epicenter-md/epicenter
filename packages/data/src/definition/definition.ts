import {
	compile as compileField,
	type Field,
	field as genericField,
	recognize,
	referenceTargetOf,
	storageOf,
} from '@epicenter/field';
import type * as Y from '@y/y';
import { type Static, type TSchema, type TUnsafe, Type } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	DATA_ADDRESS_CEILINGS,
	isDatabaseId,
	isTableName,
} from './addresses.js';
import { canonicalJson } from './canonical.js';
import type { JsonObject, JsonValue } from './json.js';

export const RESERVED_ATTRIBUTE_PREFIX = '!';
export const KV_ROOT = 'kv';
export const RESERVED_TABLE_NAMES: readonly string[] = [KV_ROOT];

/** A field descriptor as authored or serialized. */
export type FieldDescriptor = object;
export type FieldMap = {
	readonly [field: string]: FieldDescriptor;
};

/**
 * The marker a rich field's descriptor carries (ADR-0296).
 *
 * Substrate policy, like `nullable`, so it lives here rather than in the
 * closed `@epicenter/field` palette: that palette answers what a JSON value
 * is, and a rich field holds no JSON value at all. A descriptor carrying this
 * marker matches no palette meta, which is why recognition is short-circuited
 * before `recognize` ever sees it.
 */
export const YJS_TYPE_KEYWORD = 'x-yjs-type';

/** A rich field's descriptor: `Static<>` is the nested type it holds. */
export type TYjsType = TUnsafe<Y.Type> & {
	readonly [YJS_TYPE_KEYWORD]: true;
};

/**
 * A rich field: the attribute holds a nested `Y.Type` rather than a JSON value
 * (ADR-0296).
 *
 * It names what is true of storage and nothing more. Yjs 14 has one `YType`
 * that is simultaneously map, list, and rich text, so "prose" is a fact about
 * a codec and an editor binding, not about the declaration. An application
 * that wants prose, an outline, or a table writes the same `field.type()` and
 * differs only in its file codec and its editor binding.
 */
function yjsType(): TYjsType {
	return Type.Unsafe<Y.Type>({ [YJS_TYPE_KEYWORD]: true }) as TYjsType;
}

/** One row's export file, split at the fence (ADR-0296). */
export type RowFile = {
	/** The frontmatter, parsed. */
	readonly data: Record<string, JsonValue>;
	/** Everything below the fence. */
	readonly content: string;
};

export const RowFileError = defineErrors({
	/**
	 * A table's own `deserialize` refused this file.
	 *
	 * The codec's error arm, returned rather than thrown, because a folder a
	 * person hands to an import is data rather than a programmer error and the
	 * import that reads it reports which file it could not read.
	 */
	Unreadable: ({ reason, cause }: { reason: string; cause?: unknown }) => ({
		message: `This file could not be read into a row: ${reason}`,
		reason,
		cause,
	}),
});
export type RowFileError = InferErrors<typeof RowFileError>;

/**
 * A table's bidirectional file codec, erased of its declaration (ADR-0296).
 *
 * The platform owns the file FORMAT: it splits the fence, parses the
 * frontmatter into a record, and joins it back. The table owns the MAPPING,
 * which is this.
 *
 * **The two are inverses.** `serialize` takes a whole row and returns a file;
 * `deserialize` takes a file and returns a whole row, rich fields included and
 * already built. `create` integrates them in the transaction that mints the
 * row (ADR-0296, amended).
 *
 * It was not always symmetric. `deserialize` used to be handed types the
 * platform had already minted and attached, and fill them in place, because
 * ADR-0296 measured a detached `Y.Type` as unable to survive many writes. The
 * mechanism it named is real and the conclusion was too broad: a detached type
 * is safe for one bulk operation and for attribute writes, which is what every
 * codec here does and what `pmToFragment` produces, and unsafe only for a loop
 * of positional appends. `RowFileCodec` carries the rule and
 * `evidence/detached-rich-field.test.ts` pins it.
 *
 * A returned type must be fresh. Two rows given one type share one body,
 * silently, so `createRow` refuses one that already belongs to a document.
 */
export type RowFileCodec = {
	readonly serialize: (row: RowValues) => RowFile;
	readonly deserialize: (
		file: RowFile,
	) => Result<Record<string, JsonValue | Y.Type>, RowFileError>;
};

/** One row as a codec sees it: its id, its scalars, and its nested types. */
export type RowValues = {
	readonly id: string;
} & Readonly<Record<string, JsonValue | Y.Type>>;

/** One table: its fields, and optionally the codec for its export file. */
export type TableDeclaration = {
	readonly fields: FieldMap;
	readonly file?: RowFileCodec;
};

/** One application's complete, inert data definition. */
export type DataDefinition = {
	readonly id: string;
	readonly title?: string;
	readonly kv: FieldMap;
	readonly tables: {
		readonly [table: string]: TableDeclaration;
	};
};

type RejectDefault<T> = T extends { default: unknown } ? never : T;
type ValidateFields<T> = {
	[K in keyof T]: T[K] extends TSchema ? RejectDefault<T[K]> : never;
};
type ValidateTable<T> = {
	[K in keyof T]: K extends 'fields'
		? T[K] extends FieldMap
			? ValidateFields<T[K]>
			: never
		: T[K];
};
type ValidateDefinition<T> = {
	[K in keyof T]: K extends 'tables'
		? { [N in keyof T[K]]: ValidateTable<T[K][N]> }
		: K extends 'kv'
			? T[K] extends FieldMap
				? ValidateFields<T[K]>
				: never
			: T[K];
};

/**
 * Add data-substrate nullability without teaching the generic field package
 * about it.
 *
 * The declared return carries the inner schema's `Static` explicitly rather
 * than leaving it to be recovered from the `anyOf`. Structural recovery worked
 * for a plain `TString` and produced `unknown` for a branded `TUnsafe`, so
 * `field.nullable(field.string())` read as `string | null` while
 * `field.nullable(field.instant())` read as `unknown`, in the same table.
 */
function nullable<S extends TSchema>(
	inner: S,
): TUnsafe<Static<S> | null> & {
	readonly anyOf: readonly [S, { readonly type: 'null' }];
} {
	return Type.Unsafe<Static<S> | null>({
		anyOf: [inner, { type: 'null' }],
	}) as unknown as TUnsafe<Static<S> | null> & {
		readonly anyOf: readonly [S, { readonly type: 'null' }];
	};
}

/** The data definition's field namespace. */
export const field = Object.freeze({
	...genericField,
	nullable,
	type: yjsType,
});

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

/** The declared fields that hold a nested type rather than a JSON value. */
type RichKeys<TFields> = {
	[K in keyof TFields]: TFields[K] extends { readonly 'x-yjs-type': true }
		? K
		: never;
}[keyof TFields];

/** One table's rich fields, as the live types a codec fills. */
export type TypesOf<TFields> = {
	[K in RichKeys<TFields>]: Y.Type;
};

/**
 * One table's scalar fields: what `deserialize` returns and `create` takes.
 *
 * A rich field is absent from both, and that asymmetry is the engine's rather
 * than a taste: a nested type cannot be handed over as a value, so it is
 * minted with its row and filled in place.
 */
export type ScalarsOf<TFields> = FieldsOut<Omit<TFields, RichKeys<TFields>>>;

type FieldsOfArg<T> = T extends { fields: infer TFields } ? TFields : T;

/**
 * One table's read shape: the id and the scalar fields, never a rich field.
 *
 * A nested type is not a JSON value, so `readRow` skips it and `get` cannot
 * return it; a `RowOf` that named it would typecheck `note.body` and hand back
 * `undefined`. The one way to a rich field on an EXISTING row is
 * `table.content(rowId)`. Handing one IN is different and is `NewRowOf`.
 */
export type RowOf<T> = { id: string } & ScalarsOf<FieldsOfArg<T>>;
/**
 * One row as its FILE CODEC sees it: the scalars and the live rich types.
 *
 * `NewRowOf` plus the id, and the two are one shape seen from either side of
 * `create`: what you hand in, and what a file codec is handed back. A read
 * verb cannot return a nested type, so `RowOf` is scalars only; writing a file
 * is the one operation that needs both halves at once (ADR-0296).
 */
export type FileRowOf<T> = { id: string } & FieldsOut<FieldsOfArg<T>>;
/**
 * A row that does not have an id yet: the scalars, and the rich types the
 * caller built (ADR-0295, ADR-0296).
 *
 * What `create` takes and what `deserialize` returns, which is one shape
 * because they are one operation with two input formats. A rich field is
 * PASSED IN, already populated, and `create` integrates it in the transaction
 * that mints the row.
 *
 * That is a reversal of ADR-0296, which had the platform mint and attach the
 * types first. **How you fill the type you pass matters**: one bulk operation
 * or attribute writes are safe, a loop of positional appends silently reverses,
 * and it reads as empty until `create` integrates it. `RowFileCodec` states the
 * rule and `evidence/detached-rich-field.test.ts` pins it.
 *
 * A type handed here must not already belong to a document. Two rows given one
 * type SHARE one body, silently, and the same type set into two documents
 * corrupts across them; `createRow` refuses an integrated type rather than
 * letting either happen.
 *
 * Rich fields are OPTIONAL, and that is what keeps a programmatic `create`
 * from having to build an empty body it does not care about: an omitted one is
 * minted empty. A codec that means to leave a body empty says so the same way.
 */
export type NewRowOf<T> = ScalarsOf<FieldsOfArg<T>> &
	Partial<TypesOf<FieldsOfArg<T>>>;
export type KvOf<TDatabase extends DataDefinition> = FieldsOut<TDatabase['kv']>;

/** The codec as its own table declares it, read through that table's fields. */
export type RowFileCodecOf<TFields> = {
	readonly serialize: (row: FileRowOf<TFields>) => RowFile;
	readonly deserialize: (
		file: RowFile,
	) => Result<NewRowOf<TFields>, RowFileError>;
};

/**
 * Declare one table.
 *
 * **A table that declares any `field.type()` must declare `file`** (ADR-0296),
 * and the parameter type is where that is enforced, because this is the
 * authoring call and a definition that arrived serialized has no codec to
 * declare. A rich field with no codec would export a body that silently
 * vanishes, so the artifact directions refuse it as data loss rather than
 * writing an empty file.
 */
export function defineTable<const TFields extends FieldMap>(
	table: {
		fields: TFields & ValidateFields<TFields>;
	} & ([RichKeys<TFields>] extends [never]
		? { file?: RowFileCodecOf<TFields> }
		: { file: RowFileCodecOf<TFields> }),
): { fields: TFields; file?: RowFileCodec } {
	return table as unknown as { fields: TFields; file?: RowFileCodec };
}

export function defineKv<const TFields extends FieldMap>(
	fields: TFields & ValidateFields<TFields>,
): TFields {
	return fields as TFields;
}

export function defineData<const TData extends DataDefinition>(
	data: TData & ValidateDefinition<TData>,
): TData {
	// Compile eagerly at the authoring call (ADR-0266): a malformed definition
	// fails here, as the programmer error it is, rather than at first open. The
	// compile is held beside this object, so an opener that later passes the same
	// definition is a cache hit and never recompiles.
	const compiled = parseData(data);
	if (compiled.error !== null) {
		throw new Error(compiled.error.message, { cause: compiled.error });
	}
	// **A table that declares any `field.type()` must declare `file`**
	// (ADR-0296), and this is the only place the rule can be enforced at
	// runtime. `parseData` cannot: it also reads a definition that arrived as
	// JSON, which cannot carry a function, so a codec's absence there says
	// nothing. This call is the authoring boundary, where a missing codec is a
	// programmer error and the last moment it is fixable rather than a body
	// missing from a backup.
	for (const [tableName, table] of compiled.data.tables) {
		if (table.types.length === 0 || table.file !== undefined) continue;
		throw new Error(
			`Table '${tableName}' declares rich content (${table.types.join(
				', ',
			)}) and no file codec to export or import it with`,
		);
	}
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
	/**
	 * The scalar fields, compiled. A rich field is NOT here: it holds no JSON
	 * value, so it has no schema to check a payload against and nothing a
	 * conformance read could report.
	 */
	fields: ReadonlyMap<string, DataField>;
	/** The rich fields, in declaration order: the nested types a row mints. */
	types: readonly string[];
	/** The application-owned file codec, carried unread (ADR-0296). */
	file?: RowFileCodec;
	conformance(payload: JsonObject): Conformance;
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

let parsed = new WeakMap<
	object,
	Result<ParsedDataDefinition, DataDefinitionParseError>
>();

/**
 * Parse and compile one definition, held beside the definition object (ADR-0266).
 *
 * Keyed on object identity, not a content hash: `defineData` compiles once at
 * authoring and warms this cache, so an opener that later passes the same object
 * is a hit. A definition arriving as raw data, an object nobody kept, compiles on
 * arrival and is held until it is collected. A non-object cannot be cached and
 * compiles directly, on its way to the malformed result it earns.
 */
export function parseData(
	value: unknown,
): Result<ParsedDataDefinition, DataDefinitionParseError> {
	const cacheable = typeof value === 'object' && value !== null;
	if (cacheable) {
		const memoised = parsed.get(value);
		if (memoised !== undefined) return memoised;
	}
	let canonical: string;
	try {
		canonical = canonicalJson(value);
	} catch (cause) {
		return DataDefinitionParseError.Malformed({ reason: String(cause) });
	}
	const result = compileDefinition(value, canonical);
	if (cacheable) parsed.set(value, result);
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
	for (const [tableName, declaration] of Object.entries(tables)) {
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
		if (
			!isPlainObject(declaration) ||
			!isPlainObject((declaration as TableDeclaration).fields)
		) {
			return DataDefinitionParseError.Malformed({
				reason: `table '${tableName}' must declare a fields object`,
			});
		}
		const table = declaration as TableDeclaration;
		const result = compileTable(tableName, table.fields);
		if (result.error !== null) return result;
		// A codec is behavior beside the data core (ADR-0266), so a definition
		// that arrived serialized carries its functions stripped and compiles as
		// no codec at all. That is why "a table with a rich field must declare a
		// codec" is enforced at `defineTable`'s parameter type rather than here:
		// this same function parses an app bundle's `database.json` for its id,
		// and refusing that would be refusing a definition for missing something
		// JSON cannot carry. What a missing codec costs is paid at the artifact
		// boundary, where an uncoded body is a refusal in both directions.
		compiledTables.set(
			tableName,
			isFileCodec(table.file)
				? { ...result.data, file: table.file }
				: result.data,
		);
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
	const types: string[] = [];
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
		// A rich field is recognized here rather than by the palette, and before
		// it, because the palette answers what a JSON value is and this holds no
		// JSON value at all. It compiles to a NAME and nothing else: no schema, no
		// check, no storage class, so nothing downstream can mistake it for a
		// column or report it as nonconforming.
		if (descriptor[YJS_TYPE_KEYWORD] === true) {
			if (tableName === KV_ROOT) {
				return DataDefinitionParseError.Malformed({
					reason: `'${fieldName}' declares a nested type in kv, which holds settings rather than rows`,
				});
			}
			types.push(fieldName);
			continue;
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
			types: Object.freeze(types),
			conformance(payload: JsonObject): Conformance {
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

function isFileCodec(value: unknown): value is RowFileCodec {
	const codec = value as Partial<RowFileCodec> | undefined;
	return (
		typeof codec?.serialize === 'function' &&
		typeof codec.deserialize === 'function'
	);
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
	parsed = new WeakMap();
}
