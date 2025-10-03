import type { Adapter, UniqueAdapters } from './adapter';
import type { Codec, ConventionProfile } from './codec';
import type { DrizzleDb } from './db';
import type {
	DataValidator,
	Tag4,
	TransformRegistry,
	VersionDef,
} from './migrations';

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
 * Provide the target Adapter, a files map (path -> contents),
 * and the codec used to parse these files. Conventions may be overridden per-call.
 */
export type ImportOptions<TAdapters extends readonly Adapter[]> = {
	/** The target Adapter to use for importing data */
	adapterID: AdapterIDs<[UniqueAdapters<TAdapters>[number]]>;
	files: Map<string, File>;
	/** Codec (format) to use for imports. Must match the exported format */
	codec: Codec<string, string>;
	/** Optional conventions override (otherwise uses built-in default) */
	conventions?: ConventionProfile;

	/**
	 * Plan A (optional): ordered version definitions used to plan data transforms forward-only.
	 * When provided together with transforms, core will run the transform chain and then validation before upsert.
	 * Falls back to adapter-level versions when omitted.
	 */
	versions?: readonly VersionDef<Tag4>[];

	/**
	 * Plan A (optional): registry of data transforms keyed by target version tag.
	 * Must cover all forward steps when versions are provided.
	 */
	transforms?: TransformRegistry;

	/**
	 * Plan A (optional): runtime validator (e.g., drizzle-arktype) invoked after transforms.
	 * If omitted and versions/transforms are not provided, core falls back to adapter-level validator.
	 */
	dataValidator?: DataValidator;

	/**
	 * Plan A (optional): source dataset version tag; used as the starting point for the transform chain.
	 * If omitted, the host/importer should provide a sensible default (e.g., '0000') or encode version in the bundle metadata.
	 */
	sourceTag?: string;
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
	importData(options: ImportOptions<TAdapters>): Promise<void>;
	ingestData(options: IngestOptions): Promise<void>;
	getQueryInterface(): QueryInterface<TAdapters>;
};
