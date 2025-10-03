import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ColumnsSelection, InferSelectModel } from 'drizzle-orm';
import type {
	SQLiteTable,
	SubqueryWithSelection,
} from 'drizzle-orm/sqlite-core';
import type { CompatibleDB } from './db';
import type { Ingestor } from './ingestor';
import type {
	RequiredTransformTags,
	Tag4,
	TransformRegistry,
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

/** Translate schema to object, strip prefix of table names */
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
		: K]: NullToUndefined<InferSelectModel<TObj[K]>>[];
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
	TVersions extends readonly VersionDef<Tag4>[] = readonly VersionDef<Tag4>[],
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
	 * Transform registry; when provided with 'versions', tag alignment is
	 * enforced at compile time and verified at runtime.
	 */
	transforms: TransformRegistry<RequiredTransformTags<TVersions>>;
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
	return adapter;
}

/**
 * Compile-time detection of whether a table has a primary key.
 * Produces the table name union if any table is missing a primary key; else never.
 */
type TableHasPrimaryKey<TColumns> = {
	[K in keyof TColumns]: TColumns[K] extends { _: { isPrimaryKey: true } }
		? K
		: never;
}[keyof TColumns] extends never
	? false
	: true;
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
> = Adapter<TID, KeysOf<Schema>, Schema, TVersions, TPreparsed, TParsed> &
	// If any table names are NOT prefixed with `${TID}_`, attach an impossible property
	// so TS surfaces a clear, actionable error including the offending keys.
	(MissingPrefixedTables<TID, Schema> extends never
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
