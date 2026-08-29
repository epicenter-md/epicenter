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
 * The minimal read surface a document behavior sees (ADR-0264).
 *
 * The definition package cannot name the store's `RowDocumentHandle` or Yjs, so
 * it names only what a codec needs: a document is something you `get` named roots
 * from. The store's handle satisfies this structurally.
 */
export type DocumentReader = {
	get(root: string, typeName?: string | null): unknown;
};

/**
 * A row document's bidirectional file codec (ADR-0264/0267).
 *
 * A row exports as one markdown file, so there is no extension to declare:
 * `serialize` produces the file's body, and the scalar row rides above it as
 * frontmatter. `deserialize` is the import direction, reading that body back
 * into a fresh document through the same root surface `serialize` reads from.
 * Both directions belong to the application; Epicenter never interprets the
 * document.
 */
export type FileCodec = {
	readonly serialize: (doc: DocumentReader) => string;
	readonly deserialize: (text: string, doc: DocumentReader) => void;
};

/**
 * A row document's application-owned behaviors, declared beside its fields
 * (ADR-0264).
 *
 * `file` is mandatory. Only the application can turn its document into text,
 * so the codec is the one bridge an export has; a document block without it
 * would produce an artifact whose bodies silently vanish, and the artifact
 * feeds an import that replaces the store (ADR-0267).
 */
export type DocumentDeclaration = {
	/** Derive scalar row fields from the document on every local commit. */
	readonly derive?: (doc: DocumentReader) => Record<string, unknown>;
	/** The bidirectional codec between the document and its export file's body. */
	readonly file: FileCodec;
};

/** One table: its scalar fields, and optionally its row document's behaviors. */
export type TableDeclaration = {
	readonly fields: FieldMap;
	readonly document?: DocumentDeclaration;
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

/** The JSON representation carries the same closed field vocabulary; behaviors are code that rides alongside (ADR-0266). */
export type DataDefinitionJson = DataDefinition;

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

export type RowOf<T> = { id: string } & FieldsOut<
	T extends { fields: infer TFields } ? TFields : T
>;
export type CreateInputOf<T> = FieldsOut<
	T extends { fields: infer TFields } ? TFields : T
>;
export type KvOf<TDatabase extends DataDefinition> = FieldsOut<TDatabase['kv']>;
export type RowsOf<TDatabase extends DataDefinition> = {
	[K in keyof TDatabase['tables']]: RowOf<TDatabase['tables'][K]['fields']>;
};
export type CreateInputsOf<TDatabase extends DataDefinition> = {
	[K in keyof TDatabase['tables']]: CreateInputOf<
		TDatabase['tables'][K]['fields']
	>;
};

export function defineTable<const TFields extends FieldMap>(table: {
	fields: TFields & ValidateFields<TFields>;
	document?: {
		derive?: (doc: DocumentReader) => Partial<FieldsOut<TFields>>;
		file: FileCodec;
	};
}): { fields: TFields; document?: DocumentDeclaration } {
	return table as { fields: TFields; document?: DocumentDeclaration };
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
	/** The application-owned document behaviors, carried unread (ADR-0264). */
	document?: DocumentDeclaration;
	/**
	 * Which timestamps the store owns for this table (ADR-0265).
	 *
	 * Resolved here because this is where the field kinds are known. The rule is
	 * "an instant field named `createdAt` or `updatedAt`", and a store that
	 * re-derived it from `fields` would be a second place the rule is written
	 * down, free to disagree with this one.
	 */
	manages: { readonly createdAt: boolean; readonly updatedAt: boolean };
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
		// A document block is behavior beside the data core (ADR-0266), so a
		// definition that arrived serialized carries its functions stripped: the
		// inert husk left behind compiles as no block at all. An authored block,
		// told apart by any surviving function, must carry its whole codec
		// (ADR-0264/0267): the codec is the only bridge from the document to an
		// export file, and refusing where the author declared the block is the
		// last moment the missing codec is fixable rather than a body missing
		// from a backup.
		if (
			table.document !== undefined &&
			!isFileCodec(table.document.file) &&
			declaresDocumentBehavior(table.document)
		) {
			return DataDefinitionParseError.Malformed({
				reason: `table '${tableName}' declares a document without a file codec`,
			});
		}
		compiledTables.set(
			tableName,
			table.document === undefined || !isFileCodec(table.document.file)
				? result.data
				: { ...result.data, document: table.document },
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
			manages: {
				createdAt: compiled.get('createdAt')?.kind === 'instant',
				updatedAt: compiled.get('updatedAt')?.kind === 'instant',
			},
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

function isFileCodec(value: unknown): value is FileCodec {
	const codec = value as Partial<FileCodec> | undefined;
	return (
		typeof codec?.serialize === 'function' &&
		typeof codec.deserialize === 'function'
	);
}

/** Whether a document block still carries any behavior function at all. */
function declaresDocumentBehavior(document: DocumentDeclaration): boolean {
	if (typeof document.derive === 'function') return true;
	const file: unknown = document.file;
	return (
		isPlainObject(file) &&
		Object.values(file).some((member) => typeof member === 'function')
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
