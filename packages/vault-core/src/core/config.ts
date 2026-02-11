import type { Adapter, UniqueAdapters } from './adapter';
import type { Codec, ConventionProfile } from './codec';
import type { DrizzleDb } from './db';

/** Construct a Vault around a Drizzle DB. */
export type CoreOptions<TAdapters extends readonly Adapter[]> = {
	database: DrizzleDb;
	adapters: UniqueAdapters<TAdapters>;
};

/** Helper to get Adapter ID from Adapter */
export type AdapterIDs<T extends readonly { id: string }[]> = T[number]['id'];

/**
 * Per-call codec and conventions (override defaults).
 * Caller must provide the Adapter that owns the schema to export.
 */
export type ExportOptions<TAdapters extends readonly Adapter[]> = {
	/** Adapters to export (compile-time unique by id for tuple literals). Defaults to all adapters. */
	adapterIDs?: AdapterIDs<UniqueAdapters<TAdapters>>[];
	/** Codec (format) to use for exports */
	codec: Codec<string, string>;
	/** Optional conventions override (otherwise uses built-in default) */
	conventions?: ConventionProfile;
};

/**
 * Import options: caller provides files and codec only.
 * Adapters, versions, transforms, and validation are determined by adapter definitions.
 */
export type ImportOptions = {
	files: Map<string, File>;
	/** Codec (format) to use for imports. Must match the exported format */
	codec: Codec<string, string>;
};

/** IngestOptions variant for one-time single-file ingestors (e.g., ZIP). */
export type IngestOptions = {
	adapter: Adapter;
	file: File;
};

export type AdapterTables<TAdapter extends Adapter> = TAdapter['schema'];
export type AdapterTableMap<TAdapters extends readonly Adapter[]> = {
	[AdapterID in AdapterIDs<TAdapters>]: AdapterTables<
		Extract<TAdapters[number], { id: AdapterID }>
	>;
};
export type QueryInterface<TAdapters extends readonly Adapter[]> = {
	/** Map of adapter ID -> table name -> table object */
	tables: AdapterTableMap<TAdapters>;
	db: DrizzleDb;
};

/**
 * Vault: minimal API surface.
 * Methods use object method shorthand as per project conventions.
 */
export type Vault<TAdapters extends readonly Adapter[]> = {
	exportData(options: ExportOptions<TAdapters>): Promise<Map<string, File>>;
	importData(options: ImportOptions): Promise<void>;
	ingestData(options: IngestOptions): Promise<void>;
	getQueryInterface(): QueryInterface<TAdapters>;
};
