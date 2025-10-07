import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ColumnsSelection, InferSelectModel } from 'drizzle-orm';
import type {
	SQLiteTable,
	SubqueryWithSelection,
} from 'drizzle-orm/sqlite-core';
import type { CompatibleDB } from './db';
import type { Ingestor } from './ingestor';
import type {
	DataTransform,
	RequiredTransformTags,
	Tag4,
	VersionDef,
} from './migrations';

/** Column-level metadata */
export type ColumnInfo = string;

/** Per-table simple column descriptions or rich ColumnInfo for each column. */
export type ColumnDescriptions<T extends Record<string, SQLiteTable>> = {
	[K in keyof T]: {
		[C in keyof T[K]['_']['columns']]: ColumnInfo;
	};
};

/** Table metadata in human readable format. */
export type AdapterMetadata<TSchema extends Record<string, SQLiteTable>> = {
	[K in keyof TSchema]?: {
		[C in keyof TSchema[K]['_']['columns']]?: ColumnInfo;
	};
};

/** View helper used by adapters for predefined queries (optional). */
export type View<
	T extends string,
	TSelection extends ColumnsSelection,
	TSchema extends Record<string, SQLiteTable>,
	TDatabase extends CompatibleDB<TSchema>,
> = {
	name: T;
	definition: (db: TDatabase) => SubqueryWithSelection<TSelection, string>;
};

// TODO remove once https://github.com/drizzle-team/drizzle-orm/issues/2745 is resolved
/** Convert `null` properties in a type to `undefined` */
type NullToUndefined<T> = {
	[K in keyof T]: T[K] extends null
		? undefined
		: T[K] extends (infer U)[]
			? NullToUndefined<U>[]
			: Exclude<T[K], null> | ([null] extends [T[K]] ? undefined : never);
};

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type ColumnHasDefaultValue<TColumn> = TColumn extends {
	_: {
		hasDefault: infer HasDefault;
		hasRuntimeDefault: infer HasRuntimeDefault;
		isAutoincrement: infer IsAutoincrement;
	};
}
	? HasDefault extends true
		? true
		: HasRuntimeDefault extends true
			? true
			: IsAutoincrement extends true
				? true
				: false
	: false;

type ColumnKeys<TTable extends SQLiteTable> = Extract<
	keyof TTable['_']['columns'],
	string
>;

type ColumnsWithDefaults<TTable extends SQLiteTable> = {
	[K in ColumnKeys<TTable>]: ColumnHasDefaultValue<
		TTable['_']['columns'][K]
	> extends true
		? K
		: never;
}[ColumnKeys<TTable>];

type ApplyDefaultableColumns<
	TTable extends SQLiteTable,
	TRow extends Record<string, unknown>,
> = Simplify<
	Omit<TRow, Extract<ColumnsWithDefaults<TTable>, keyof TRow>> & {
		[K in Extract<ColumnsWithDefaults<TTable>, keyof TRow>]?:
			| TRow[K]
			| undefined;
	}
>;

// Allow server generated columns (defaults, runtime defaults, autoincrement IDs) to be omitted in validator payloads.
type TableRowShape<TTable extends SQLiteTable> = NullToUndefined<
	InferSelectModel<TTable>
> extends infer Row
	? Row extends Record<string, unknown>
		? ApplyDefaultableColumns<TTable, Row>
		: Row
	: never;

/**
 * Map a prefixed schema record to an object whose keys are the table names with the
 * adapter prefix removed and whose values are arrays of the inferred row type.
 *
 * This represents the natural shape for bulk ingestion: each table produces many rows.
 *
 * @example `reddit` ID and `reddit_posts` table become `posts`
 */
export type SchemaMappedToObject<
	TID extends string,
	TObj extends Record<string, SQLiteTable>,
> = {
	[K in keyof TObj as K extends `${TID}_${infer Rest}`
		? Rest
		: K]: TableRowShape<TObj[K]>[];
};

type TransformAlignment<TVersions extends readonly VersionDef<Tag4>[]> = {
	[K in RequiredTransformTags<TVersions>]: DataTransform;
} & {
	[K in Exclude<Tag4, RequiredTransformTags<TVersions>>]?: never;
};

/**
 * Unified Adapter: schema + parsing/upsert lifecycle.
 */
export interface Adapter<
	TID extends string = string,
	TTableNames extends string = string,
	TSchema extends Record<TTableNames, SQLiteTable> = Record<
		string,
		SQLiteTable
	>,
	TVersions extends
		readonly VersionDef<string>[] = readonly VersionDef<string>[],
	TPreparsed = unknown,
	TParsed = unknown,
> {
	/** Unique identifier for the adapter (lowercase, no spaces, alphanumeric) */
	id: TID;

	/** Drizzle schema object. */
	schema: TID extends string
		? TSchema
		: EnsureAllTablesArePrefixedWith<TID, TSchema> extends never
			? never
			: EnsureSchemaHasPrimaryKeys<TSchema>;

	/** Adapter metadata for UI/help */
	metadata?: AdapterMetadata<TSchema>;

	/** Optional predefined views
	 * Note: to avoid function parameter variance issues in structural assignability,
	 * we use a base schema shape for the DB parameter rather than the adapter's TSchema.
	 */
	views?: {
		[Alias in string]: View<
			Alias,
			ColumnsSelection,
			Record<string, SQLiteTable>,
			CompatibleDB<Record<string, SQLiteTable>>
		>;
	};

	/** Pipelines for importing new data. Validation/morphing happens via `adapter.validator` */
	ingestors?: readonly Ingestor<TPreparsed>[];

	/**
	 * Optional Standard Schema validator for parsed payload (ingest pipeline).
	 */
	validator?: StandardSchemaV1<TPreparsed, TParsed>;

	/**
	 * Authoring-time versions tuple used for JS transform tag alignment checks
	 * and runtime transform planning.
	 */
	versions: TVersions;

	/**
	 * Transform registry for forward data migrations. Alignment with versions is enforced
	 * when adapters are authored through `defineAdapter`.
	 */
	transforms: Partial<Record<Tag4, DataTransform>>;
}

/**
 * Define a new adapter where the validator's parsed output must match the schema's InferSelect shape,
 * where all tables are prefixed and have primary keys, and (optionally) enforce JS transform tag alignment when 'versions' and 'transforms' are provided.
 */
export function defineAdapter<
	const TID extends string,
	TSchema extends Record<string, SQLiteTable>,
	TVersions extends readonly VersionDef<Tag4>[] = readonly VersionDef<Tag4>[],
	TPreparsed = unknown,
	TParsed = SchemaMappedToObject<TID, TSchema>,
>(
	adapter: () => PrefixedAdapter<TID, TSchema, TVersions, TPreparsed, TParsed>,
): () => PrefixedAdapter<TID, TSchema, TVersions, TPreparsed, TParsed>;
export function defineAdapter<
	const TID extends string,
	TSchema extends Record<string, SQLiteTable>,
	TPreparsed,
	TVersions extends readonly VersionDef<Tag4>[],
	TParsed = SchemaMappedToObject<TID, TSchema>,
	TArgs extends unknown[] = [],
>(
	adapter: (
		...args: TArgs
	) => PrefixedAdapter<TID, TSchema, TVersions, TPreparsed, TParsed>,
): (
	...args: TArgs
) => PrefixedAdapter<TID, TSchema, TVersions, TPreparsed, TParsed>;
export function defineAdapter<F extends (...args: unknown[]) => unknown>(
	adapter: F,
): F {
	const wrapped = ((...args: Parameters<F>) => {
		const instance = adapter(...args);
		validateTransformsAgainstVersions(instance as Adapter);
		return instance;
	}) as unknown as F;
	return wrapped;
}

/**
 * Compile-time detection of whether a table has a primary key.
 * Looks for any column with an internal `_.isPrimaryKey === true` flag.
 * Produces `true` when at least one PK column exists; otherwise `false`.
 */
type TableHasPrimaryKey<TTable> = TTable extends {
	_: { columns: infer TCols extends Record<string, unknown> };
}
	? {
			[K in keyof TCols]: TCols[K] extends { _: { isPrimaryKey: true } }
				? K
				: never;
		}[keyof TCols] extends never
		? false
		: true
	: false;
type EnsureSchemaHasPrimaryKeys<S extends Record<string, SQLiteTable>> = {
	[K in keyof S]: TableHasPrimaryKey<S[K]> extends false ? never : K & string;
}[keyof S];

type KeysOf<S> = Extract<keyof S, string>;

/**
 * Compile time check for table name prefixing
 */
type PrefixedAdapter<
	TID extends string,
	Schema extends Record<string, SQLiteTable>,
	TVersions extends readonly VersionDef<Tag4>[],
	TPreparsed,
	TParsed,
> = Adapter<TID, KeysOf<Schema>, Schema, TVersions, TPreparsed, TParsed> & {
	transforms: TransformAlignment<TVersions>;
} & (MissingPrefixedTables<TID, Schema> extends never // so TS surfaces a clear, actionable error including the offending keys. // If any table names are NOT prefixed with `${TID}_`, attach an impossible property
		? unknown
		: {
				__error__schema_table_prefix_mismatch__: `Expected all tables to start with "${TID}_"`;
			}) &
	// If any tables are missing primary keys, surface them similarly
	(MissingPrimaryKeyTables<Schema> extends never
		? unknown
		: {
				__error__missing_primary_keys__: MissingPrimaryKeyTables<Schema>;
			});

// Compute the set of schema keys that are NOT prefixed with `${TID}_`
type MissingPrefixedTables<
	TID extends string,
	TSchema extends Record<string, SQLiteTable>,
> = Exclude<SchemaTableNames<TSchema>, `${TID}_${string}`>;

// Compute the set of tables that do not declare a primary key
type MissingPrimaryKeyTables<S extends Record<string, SQLiteTable>> = {
	[K in keyof S]: TableHasPrimaryKey<S[K]> extends false ? K & string : never;
}[keyof S];

type EnsureAllTablesArePrefixedWith<
	TID extends string,
	TSchema extends Record<string, SQLiteTable>,
> = Exclude<SchemaTableNames<TSchema>, `${TID}_${string}`> extends never
	? TSchema
	: never;
type SchemaTableNames<TSchema extends Record<string, SQLiteTable>> = Extract<
	keyof TSchema,
	string
>;

/**
 * Compile-time detection of duplicate adapter IDs in a tuple.
 * Produces the first duplicate ID union if any; otherwise never.
 */
type NoDuplicateAdapter<
	T extends readonly { id: string }[],
	Seen extends string = never,
> = T extends readonly [infer H, ...infer R]
	? H extends { id: infer ID extends string }
		? ID extends Seen
			? ID | NoDuplicateAdapter<Extract<R, readonly { id: string }[]>, Seen>
			: NoDuplicateAdapter<Extract<R, readonly { id: string }[]>, Seen | ID>
		: never
	: never;

/**
 * Enforce unique adapter IDs at the type level for tuple literals.
 * Evaluates to T when no duplicates; else never (surfacing a type error).
 */
export type UniqueAdapters<T extends readonly Adapter[]> =
	NoDuplicateAdapter<T> extends never ? T : never;

function validateTransformsAgainstVersions(adapter: Adapter) {
	const versions = adapter.versions ?? [];
	if (!versions.length) return;

	const declaredTags = versions.map((v) => v.tag);
	const required = declaredTags.slice(1);
	const transforms = adapter.transforms ?? {};
	const actual = Object.keys(transforms);

	const missing = required.filter((tag) => !actual.includes(tag));
	const extras = actual.filter((tag) => !required.includes(tag));

	if (missing.length > 0 || extras.length > 0) {
		throw new Error(
			`defineAdapter: adapter '${adapter.id}' transforms do not match versions. ` +
				`required=[${required.join(',')}] actual=[${actual.join(',')}] ` +
				`missing=[${missing.join(',')}] extras=[${extras.join(',')}]`,
		);
	}
}
