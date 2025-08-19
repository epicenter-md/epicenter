import type { Type } from 'arktype';
import type { ColumnsSelection } from 'drizzle-orm';
import type {
	SQLiteTable,
	SubqueryWithSelection,
} from 'drizzle-orm/sqlite-core';
import type {
	Adapter,
	ColumnDescriptions,
	CompatibleDB,
	DrizzleConfig,
} from './adapter';

export type View<
	T extends string,
	TSelection extends ColumnsSelection,
	TSchema extends Record<string, SQLiteTable>,
	TDatabase extends CompatibleDB<TSchema>,
> = {
	name: T;
	definition: (db: TDatabase) => SubqueryWithSelection<TSelection, string>;
};

export interface Importer<
	TID extends string = string,
	TSchema extends Record<string, SQLiteTable> = Record<string, SQLiteTable>,
	TDatabase extends CompatibleDB<TSchema> = CompatibleDB<TSchema>,
	TParserShape extends Type = Type,
	TParsed = TParserShape['infer'],
> {
	/** Unique identifier for the importer (lowercase, no spaces, alphanumeric) */
	id: TID;
	/** User-facing name */
	name: string;
	/** Adapter (schema provider) */
	adapter: Adapter<TID, Extract<keyof TSchema, string>, TSchema>;
	/** Column descriptions for every table/column */
	metadata: ColumnDescriptions<TSchema>;
	/** ArkType schema for parsing/validation */
	validator: TParserShape;
	/** Predefined views/CTEs for common queries */
	views?: {
		[Alias in string]: View<Alias, ColumnsSelection, TSchema, TDatabase>;
	};
	/** Drizzle config for this schema (migrations, casing, etc.) */
	drizzleConfig: DrizzleConfig;
	/** Parse a blob into a parsed representation */
	parse: (file: Blob) => Promise<TParsed>;
	/** Upsert data into the database */
	upsert: (db: TDatabase, data: TParsed) => Promise<void>;
}

// Helper to compose an Importer from a web-safe Adapter + Node-only pieces
export type ImporterNodeParts<
	TID extends string,
	TSchema extends Record<string, SQLiteTable>,
	TDatabase extends CompatibleDB<TSchema>,
	TParserShape extends Type,
	TParsed,
> = Omit<
	Importer<TID, TSchema, TDatabase, TParserShape, TParsed>,
	'id' | 'adapter'
>;

export function defineImporter<
	TID extends string,
	TSchema extends Record<string, SQLiteTable>,
	TDatabase extends CompatibleDB<TSchema>,
	TParserShape extends Type,
	TParsed = TParserShape['infer'],
>(
	adapter: Adapter<TID, Extract<keyof TSchema, string>, TSchema>,
	parts: ImporterNodeParts<TID, TSchema, TDatabase, TParserShape, TParsed>,
): Importer<TID, TSchema, TDatabase, TParserShape, TParsed> {
	return {
		id: adapter.id,
		adapter,
		...parts,
	};
}

// Back-compat alias; prefer defineImporter going forward
export const composeImporter = defineImporter;
