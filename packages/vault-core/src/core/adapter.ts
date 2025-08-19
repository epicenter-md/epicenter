import type { defineConfig } from 'drizzle-kit';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { BaseSQLiteDatabase, SQLiteTable } from 'drizzle-orm/sqlite-core';

// Shared types
type ExtractedResult<T> = T extends BaseSQLiteDatabase<'async', infer R>
	? R
	: never;

type ResultSet = ExtractedResult<LibSQLDatabase>;

// Represents compatible Drizzle DB types across the codebase
export type CompatibleDB<TSchema> = BaseSQLiteDatabase<
	'sync' | 'async',
	TSchema | ResultSet
>;

export type DrizzleConfig = ReturnType<typeof defineConfig>;

export type ColumnDescriptions<T extends Record<string, SQLiteTable>> = {
	[K in keyof T]: {
		[C in keyof T[K]['_']['columns']]: string;
	};
};

// --- Schema & table-name helpers -------------------------------------------------

/** Union of table name literals from the schema's keys. */
export type SchemaTableNames<TSchema extends Record<string, SQLiteTable>> =
	Extract<keyof TSchema, string>;

/** Ensure all tables in a schema have names prefixed with the given Adapter ID. */
// Check that all table names in the schema start with `${TID}_`
export type SchemaTablesAllPrefixed<
	TID extends string,
	TSchema extends Record<string, SQLiteTable>,
> = Exclude<SchemaTableNames<TSchema>, `${TID}_${string}`> extends never
	? 1
	: 0;

// Adapter is schema-only. Importers wire lifecycle, parsing, views, etc.
export interface Adapter<
	TID extends string = string,
	TTableNames extends string = string,
	TSchema extends Record<TTableNames, SQLiteTable> = Record<
		string,
		SQLiteTable
	>,
> {
	/** Unique identifier for the adapter (lowercase, no spaces, alphanumeric) */
	id: TID;
	/** Database schema */
	schema: TSchema;
}

// Note: If a generic only appears in a function parameter position, TS won't infer it and will
// fall back to the constraint (e.g. `object`). These overloads infer the full function type `F` instead.
type KeysOf<S> = Extract<keyof S, string>;
type PrefixedAdapter<
	TID extends string,
	S extends Record<string, SQLiteTable>,
> = KeysOf<S> extends `${TID}_${string}` ? Adapter<TID, KeysOf<S>, S> : never;

export function defineAdapter<
	TID extends string,
	S extends Record<string, SQLiteTable>,
>(adapter: () => PrefixedAdapter<TID, S>): () => PrefixedAdapter<TID, S>;
export function defineAdapter<
	TID extends string,
	S extends Record<string, SQLiteTable>,
	A extends unknown[],
>(
	adapter: (...args: A) => PrefixedAdapter<TID, S>,
): (...args: A) => PrefixedAdapter<TID, S>;
export function defineAdapter<F extends (...args: unknown[]) => unknown>(
	adapter: F,
): F {
	return adapter;
}

// --- Cross-adapter utilities -----------------------------------------------------

/** Get table-name union for a single Adapter-like value (Adapter or { schema }). */
export type TableNamesOfAdapterLike<T> = T extends { schema: infer S }
	? S extends Record<string, SQLiteTable>
		? SchemaTableNames<S>
		: never
	: never;

/** Get table-name union for an Importer-like value (has adapter.schema). */
export type TableNamesOfImporterLike<T> = T extends {
	adapter: { schema: infer S };
}
	? S extends Record<string, SQLiteTable>
		? SchemaTableNames<S>
		: never
	: never;

/** Compute table-name union for any array of Adapters or Importers. */
export type TableNamesOfMany<T extends readonly unknown[]> =
	T[number] extends infer E
		? E extends { schema: Record<string, SQLiteTable> }
			? TableNamesOfAdapterLike<E>
			: E extends { adapter: { schema: Record<string, SQLiteTable> } }
				? TableNamesOfImporterLike<E>
				: never
		: never;

/** Compute collisions (duplicates) of table names across an array of Adapters/Importers. */
export type TableNameCollisions<
	T extends readonly unknown[],
	Acc extends string = never,
> = T extends readonly [infer H, ...infer R]
	? H extends
			| { schema: Record<string, SQLiteTable> }
			| {
					adapter: { schema: Record<string, SQLiteTable> };
			  }
		?
				| Extract<TableNamesOfMany<[H]>, TableNamesOfMany<R>>
				| TableNameCollisions<R>
		: TableNameCollisions<R>
	: Acc;

/** Assert there are no duplicate table names; resolves to T when valid, else never. */
export type NoTableNameCollisions<T extends readonly unknown[]> =
	TableNameCollisions<T> extends never ? T : never;

/** Ensure all adapters' schemas are correctly prefixed. Returns T when OK, else never. */
export type AllAdaptersPrefixed<T extends readonly Adapter[]> = Exclude<
	T[number] extends Adapter<infer ID, infer K, infer S>
		? SchemaTablesAllPrefixed<ID & string, S & Record<K & string, SQLiteTable>>
		: 1,
	1
> extends never
	? T
	: never;

/** Ensure all importers' adapter schemas are correctly prefixed. Returns T when OK, else never. */
export type AllImportersPrefixed<T extends readonly unknown[]> = Exclude<
	T[number] extends { id: infer ID; adapter: { schema: infer S } }
		? SchemaTablesAllPrefixed<ID & string, S & Record<string, SQLiteTable>>
		: 1,
	1
> extends never
	? T
	: never;

// Utility to merge a union of schema records into a single record via intersection
export type UnionToIntersection<U> = (
	U extends unknown
		? (k: U) => void
		: never
) extends (k: infer I) => void
	? I
	: never;

/**
 * Build a joined schema record from:
 * - a VaultService-like object (has `importers`)
 * - a VaultClient-like object (has `adapters`)
 * - an array of Importers (have `adapter.schema`)
 * - an array of Adapters (have `schema`)
 */
/**
 * Normalize any schema-like type to a concrete Record<string, SQLiteTable>.
 * - If S is already a schema record, it's returned unchanged.
 * - Otherwise, returns a broad Record<string, SQLiteTable> so downstream
 *   utilities (e.g. JoinedSchema<...>) produce a usable record instead of never
 *   when inputs are unknown/never/empty unions.
 */
type EnsureSchema<S> = S extends Record<string, SQLiteTable>
	? S
	: Record<string, SQLiteTable>;
export type JoinedSchema<T> = EnsureSchema<
	T extends { importers: infer I }
		? UnionToIntersection<
				SchemaOfMany<I extends readonly unknown[] ? I : never>
			>
		: T extends { adapters: infer A }
			? UnionToIntersection<
					SchemaOfMany<A extends readonly unknown[] ? A : never>
				>
			: T extends readonly unknown[]
				? UnionToIntersection<SchemaOfMany<T>>
				: never
>;

type SchemaOfAdapterLike<T> = T extends { schema: infer S }
	? S extends Record<string, SQLiteTable>
		? S
		: never
	: never;
type SchemaOfImporterLike<T> = T extends { adapter: { schema: infer S } }
	? S extends Record<string, SQLiteTable>
		? S
		: never
	: never;
type SchemaOfMany<T extends readonly unknown[] | never> = [T] extends [never]
	? never
	: T[number] extends infer E
		? SchemaOfAdapterLike<E> | SchemaOfImporterLike<E>
		: never;

// Validate arrays of adapters/importers for prefixing and collisions
export type CheckNoCollisions<T extends readonly unknown[]> =
	TableNameCollisions<T> extends never ? T : never;

/**
 * Validate an array/tuple of Importers at compile time:
 * - Ensures each importer's adapter schema keys are prefixed with `${ID}_`.
 * - Ensures there are no duplicate table names across all importers.
 * Resolves to T when valid; otherwise resolves to never to surface a type error.
 */
export type EnsureImportersOK<T extends readonly unknown[]> =
	AllImportersPrefixed<T> extends never ? never : CheckNoCollisions<T>;
/**
 * Validate an array/tuple of Adapters at compile time:
 * - Ensures each adapter's schema keys are prefixed with `${id}_`.
 * - Ensures there are no duplicate table names across all adapters.
 * Resolves to T when valid; otherwise resolves to never to surface a type error.
 */
export type EnsureAdaptersOK<T extends readonly unknown[]> =
	AllAdaptersPrefixed<T & readonly Adapter[]> extends never
		? never
		: CheckNoCollisions<T>;
