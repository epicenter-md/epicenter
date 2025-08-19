import type { defineConfig } from 'drizzle-kit';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { BaseSQLiteDatabase, SQLiteTable } from 'drizzle-orm/sqlite-core';

// Shared types
type ExtractedResult<T> = T extends BaseSQLiteDatabase<'async', infer R>
	? R
	: never;

type ResultSet = ExtractedResult<LibSQLDatabase>;

// Represents compatible Drizzle DB types across the codebase
export type CompatibleDB<TSchema = Record<string, SQLiteTable>> =
	BaseSQLiteDatabase<'sync' | 'async', TSchema | ResultSet>;

export type DrizzleConfig = ReturnType<typeof defineConfig>;

export type ColumnDescriptions<T extends Record<string, SQLiteTable>> = {
	[K in keyof T]: {
		[C in keyof T[K]['_']['columns']]: string;
	};
};

// Adapter is schema-only. Importers wire lifecycle, parsing, views, etc.
export interface Adapter<
	TID extends string = string,
	TSchema extends Record<string, SQLiteTable> = Record<string, SQLiteTable>,
> {
	/** Unique identifier for the adapter (lowercase, no spaces, alphanumeric) */
	id: TID;
	/** Database schema */
	schema: TSchema;
}

// Note: If a generic only appears in a function parameter position, TS won't infer it and will
// fall back to the constraint (e.g. `object`). These overloads infer the full function type `F` instead.
export function defineAdapter<TID extends string, F extends () => Adapter<TID>>(
	adapter: F,
): F;
export function defineAdapter<
	// biome-ignore lint/suspicious/noExplicitAny: Variance-friendly identity for adapter factories
	F extends (args: any) => Adapter<any>,
>(adapter: F): F;
export function defineAdapter<F extends (...args: unknown[]) => unknown>(
	adapter: F,
): F {
	return adapter;
}
