import {
	compile as compileField,
	type Field,
	field as genericField,
	recognize,
	referenceTargetOf,
	storageOf,
} from '@epicenter/field';
import type * as Y from '@y/y';
import { type Static, type TSchema, Type } from 'typebox';
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

/**
 * The fields of one bucket, by name.
 *
 * A field IS a schema. It was `object` for one release, so that this one type
 * could describe both a declaration written with `field.*` and one that arrived
 * as JSON, and every type reading a declaration paid for it: unable to assume a
 * schema, each asked `extends TSchema` and answered `never` when the guess
 * failed. A wrong answer, silently, rather than an error.
 *
 * Nothing needed it. A definition read from JSON reaches `parseData` as
 * `unknown` and is validated there (`apps/epicenter/src/static-assets.ts` is
 * the one caller that does it), so the serialized shape never had a static
 * form to accommodate. What is declared here is what an author writes.
 */
export type FieldMap = {
	readonly [field: string]: TSchema;
};

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
 * `deserialize` takes a file and returns a whole row, type fields included and
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
 * `evidence/detached-type.test.ts` pins it.
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

/**
 * One table's declaration, as the inert definition carries it.
 *
 * TWO BUCKETS. A scalar holds a JSON value: replaced whole on write, last write
 * wins. A type field holds a live `Y.Type`: edited in place, merging
 * internally. They are different in every operation, so the declaration says
 * so rather than hiding it in a marker for the type system to rediscover.
 */
export type TableDeclaration = {
	/** The fields holding a JSON value. */
	readonly scalars: FieldMap;
	/**
	 * The fields holding a live `Y.Type`, by name.
	 *
	 * Names and nothing else, because there is nothing to configure: a type
	 * field has no schema, no nullability and no format. It used to be declared
	 * with `field.type()`, a descriptor whose entire content was a marker
	 * saying "I am not a descriptor", and what that marker smuggled through the
	 * scalars was this list.
	 */
	readonly types?: readonly string[];
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
	[K in keyof T]: K extends 'scalars'
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
 * `Type.Union` with `Type.Null`, which is TypeBox's own spelling of exactly
 * this. It emits the same `anyOf: [inner, { type: 'null' }]` the hand-rolled
 * version did, byte for byte, and infers `Static<S> | null` including for a
 * BRANDED inner schema, which is the case that made this a function in the
 * first place.
 *
 * It used to be built with `Type.Unsafe` and two casts, because a schema
 * assembled that way leaves its `Static` to be recovered structurally from the
 * `anyOf` and that recovery produced `unknown` for a branded `TUnsafe`:
 * `field.nullable(field.string())` read as `string | null` while
 * `field.nullable(field.instant())` read as `unknown`, in the same table. That
 * is a real defect in structural recovery and it is not a reason to reach for
 * the escape hatch, because `Type.Union` never had it.
 *
 * The old return type also carried `& { anyOf: readonly [S, …] }` so the shape
 * could be read back at the type level. Nothing ever read it: `nullableParts`
 * recognizes a nullable field at RUNTIME, off an untyped record.
 */
function nullable<S extends TSchema>(inner: S) {
	return Type.Union([inner, Type.Null()]);
}

/** The data definition's field namespace. */
export const field = Object.freeze({
	...genericField,
	nullable,
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

/** What one bucket's fields read as, once the schemas are resolved. */
type FieldsOut<TFields extends FieldMap> = {
	[K in keyof TFields]: Static<TFields[K]>;
};

/**
 * One table's type fields: the live `Y.Type` at each declared name.
 *
 * A lookup, not a filter. The declaration already lists them, and a table that
 * declares none lists nothing: `NonNullable` covers the absent key without a
 * conditional, because absent and empty are the same answer here.
 */
export type TypesOf<T extends TableDeclaration> = {
	[K in NonNullable<T['types']>[number]]: Y.Type;
};

/**
 * One table's scalar fields: what `update` may patch, what `deserialize`
 * returns beside the types it built, and what a codec writes to frontmatter.
 *
 * A type field is absent because a type is not assignable: writing one over a
 * row's attribute deletes the old subtree, so a peer that edited it
 * concurrently loses every keystroke to map LWW. That rule is why this type
 * exists, and stating it as a signature is what keeps it from being a comment
 * somebody has to obey.
 */
export type ScalarsOf<T extends TableDeclaration> = FieldsOut<T['scalars']>;

/**
 * One table's read shape: the id, the scalars, and the live types.
 *
 * What `get` returns, what `create` returns, and what a file codec's
 * `serialize` takes. It was scalars only, with `content(rowId)` as the one way
 * to a type field and `RowOf` as a third shape for the codec; the row
 * carries its types now, so all three collapse into this (ADR-0296, amended).
 *
 * `NewRowOf` is this minus the id and with the types optional. That sentence is
 * the whole relationship between the two shapes an application ever names.
 */
export type RowOf<T extends TableDeclaration> = { id: string } & ScalarsOf<T> &
	TypesOf<T>;
/**
 * A row that does not have an id yet: the scalars, and the type types the
 * caller built (ADR-0295, ADR-0296).
 *
 * What `create` takes and what `deserialize` returns, which is one shape
 * because they are one operation with two input formats. A type field is
 * PASSED IN, already populated, and `create` integrates it in the transaction
 * that mints the row.
 *
 * That is a reversal of ADR-0296, which had the platform mint and attach the
 * types first. **How you fill the type you pass matters**: one bulk operation
 * or attribute writes are safe, a loop of positional appends silently reverses,
 * and it reads as empty until `create` integrates it. `RowFileCodec` states the
 * rule and `evidence/detached-type.test.ts` pins it.
 *
 * A type handed here must not already belong to a document. Two rows given one
 * type SHARE one body, silently, and the same type set into two documents
 * corrupts across them; `createRow` refuses an integrated type rather than
 * letting either happen.
 *
 * Type fields are OPTIONAL, and that is what keeps a programmatic `create`
 * from having to build an empty body it does not care about: an omitted one is
 * minted empty. A codec that means to leave a body empty says so the same way.
 */
export type NewRowOf<T extends TableDeclaration> = ScalarsOf<T> &
	Partial<TypesOf<T>>;
export type KvOf<TDatabase extends DataDefinition> = FieldsOut<TDatabase['kv']>;

/** The codec as its own table declares it, read through that table's fields. */
export type RowFileCodecOf<TFields extends TableDeclaration> = {
	readonly serialize: (row: RowOf<TFields>) => RowFile;
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
 * declare. A type field with no codec would export a body that silently
 * vanishes, so the artifact directions refuse it as data loss rather than
 * writing an empty file.
 *
 * The return ERASES the codec's types, and the cast is what that costs. A
 * `DataDefinition` holds every table under one shape, so it cannot be generic
 * over each table's fields; `RowFileCodecOf<TFields>` narrows `serialize`'s
 * parameter, and a narrowed parameter is not assignable to a wider one. The
 * typing that matters happens here, at the authoring call, and the store reads
 * the erased form.
 */
export function defineTable<
	const TScalars extends FieldMap,
	const TTypes extends readonly string[] = readonly [],
>(
	table: {
		scalars: TScalars & ValidateFields<TScalars>;
		types?: TTypes;
	} & ([TTypes[number]] extends [never]
		? { file?: RowFileCodecOf<{ scalars: TScalars; types: TTypes }> }
		: { file: RowFileCodecOf<{ scalars: TScalars; types: TTypes }> }),
): { scalars: TScalars; types: TTypes; file?: RowFileCodec } {
	return table as unknown as {
		scalars: TScalars;
		types: TTypes;
		file?: RowFileCodec;
	};
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
			`Table '${tableName}' declares type content (${table.types.join(
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
	 * The scalar fields, compiled. A type field is NOT here: it holds no JSON
	 * value, so it has no schema to check a payload against and nothing a
	 * conformance read could report.
	 */
	fields: ReadonlyMap<string, DataField>;
	/** The type fields, in declaration order: the nested types a row mints. */
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

const parsed = new WeakMap<
	object,
	Result<ParsedDataDefinition, DataDefinitionParseError>
>();

/**
 * Parse and compile one definition, held beside the definition object (ADR-0266).
 *
 * Keyed on object identity, not a content hash. The memo is what makes eager
 * validation free: `defineData` compiles at the authoring call so a malformed
 * definition fails there rather than at first open (ADR-0266), and without this
 * every opener would redo that work. It is not here for the milliseconds; it is
 * here so "validate early" does not mean "validate twice".
 *
 * A definition arriving as raw data, an object nobody kept, compiles on arrival
 * and is held until it is collected. A non-object cannot be cached and compiles
 * directly, on its way to the malformed result it earns.
 *
 * Identity keying means a definition MUTATED IN PLACE would read back its old
 * parse. There used to be a `clearDataDefinitionCache` for that, exported and
 * called by nothing, including the tests it named. Nothing mutates a
 * definition: they are module-level constants built from `field.*`, and the
 * parse freezes its own canonical copy. An escape hatch for an unreachable
 * hazard mostly advertises that the hazard is reachable.
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

	const compiledKvResult = compileTable('kv', kv, []);
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
			!isPlainObject((declaration as TableDeclaration).scalars)
		) {
			return DataDefinitionParseError.Malformed({
				reason: `table '${tableName}' must declare a scalars object`,
			});
		}
		const table = declaration as TableDeclaration;
		if (table.types !== undefined && !Array.isArray(table.types)) {
			return DataDefinitionParseError.Malformed({
				reason: `table '${tableName}' declares 'types' as something other than a list of field names`,
			});
		}
		const result = compileTable(tableName, table.scalars, table.types ?? []);
		if (result.error !== null) return result;
		// A codec is behavior beside the data core (ADR-0266), so a definition
		// that arrived serialized carries its functions stripped and compiles as
		// no codec at all. That is why "a table with a type field must declare a
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
	scalars: unknown,
	declaredTypes: readonly string[],
): Result<ParsedTable, DataDefinitionParseError> {
	if (!isPlainObject(scalars))
		return DataDefinitionParseError.Malformed({
			reason: `table '${tableName}' does not declare scalars`,
		});
	const compiled = new Map<string, DataField>();
	// A type field compiles to a NAME and nothing else: no schema, no check, no
	// storage class, so nothing downstream can mistake it for a column or report
	// it as nonconforming. The declaration is the list, which is why it no
	// longer needs a descriptor to carry a marker through the scalars.
	const types: string[] = [];
	for (const fieldName of declaredTypes) {
		if (tableName === KV_ROOT) {
			return DataDefinitionParseError.Malformed({
				reason: `'${fieldName}' declares a type field in kv, which holds settings rather than rows`,
			});
		}
		const invalid = fieldNameProblem(tableName, fieldName);
		if (invalid !== undefined) return invalid;
		if (fieldName in scalars) {
			return DataDefinitionParseError.Malformed({
				reason: `'${fieldName}' is declared as both a scalar and a type field of table '${tableName}'`,
			});
		}
		if (types.includes(fieldName)) {
			return DataDefinitionParseError.Malformed({
				reason: `'${fieldName}' is declared twice in table '${tableName}' types`,
			});
		}
		types.push(fieldName);
	}
	for (const [fieldName, descriptor] of Object.entries(scalars)) {
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
