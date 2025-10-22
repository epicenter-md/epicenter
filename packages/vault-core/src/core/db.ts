import type { AnyTable as AnyTableGeneric } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

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

/** Minimal Drizzle-DB type expected by core. Hosts pass a concrete Drizzle instance. */
export type DrizzleDb = CompatibleDB<unknown>;

export type AnyTable = AnyTableGeneric<{ name: string }>; // simplify usage
