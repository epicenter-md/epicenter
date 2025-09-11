import type { MigrationConfig } from 'drizzle-orm/migrator';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { Adapter } from './adapter';
import type { Codec, ConventionProfile } from './codec';
import type { Importer } from './importer';

// Deprecated: use VaultServiceConfig or VaultClientConfig
export interface VaultConfig<
	TDatabase extends BaseSQLiteDatabase<'sync' | 'async', unknown>,
	TImporters extends Importer[],
> {
	adapters: TImporters;
	database: TDatabase;
	migrateFunc: (db: TDatabase, config: MigrationConfig) => Promise<void>;
}

// Service config: owns DB and Importers
/**
 * @deprecated The service/client architecture has been removed from vault-core.
 * Prefer a pure core API with an injected Drizzle DB and per-call codec injection.
 */
export interface VaultServiceConfig<
	TDatabase extends BaseSQLiteDatabase<'sync' | 'async', unknown>,
	TImporters extends Importer[],
> {
	/**
	 * Importers installed on the service.
	 *
	 * Importers encapsulate end-to-end behavior for a source: parse(blob), validate, upsert(db),
	 * and also reference an Adapter which carries the Drizzle schema + migrations config.
	 *
	 * @see Importer
	 */
	importers: TImporters;
	/**
	 * Database connection instance used by the service.
	 *
	 * Example (libsql):
	 * const client = createClient({ url, authToken });
	 * const db = drizzle(client);
	 */
	database: TDatabase;
	/**
	 * Drizzle platform-specific migration function used to run migrations for each importer.
	 *
	 * Example (libsql):
	 * import { migrate } from 'drizzle-orm/libsql/migrator';
	 * migrate(db, { migrationsFolder: '...' })
	 */
	migrateFunc: (db: TDatabase, config: MigrationConfig) => Promise<void>;
	/** Active text codec (markdown/json/etc.) and the conventions. */
	codec?: Codec<string, string>;
	conventions?: ConventionProfile;
}

// Client config: only needs adapters for schema/metadata typing and UI
export interface VaultClientConfig<TAdapters extends Adapter[]> {
	/**
	 * Adapters provide schema (and optional metadata) for type-safety in the client.
	 *
	 * The client does not perform database operations; it uses adapters to render UI,
	 * build queries, and display human-readable table/column info.
	 *
	 * @see Adapter
	 */
	adapters: TAdapters;
	/**
	 * Optional transport configuration placeholder.
	 *
	 * The specific RPC transport between client and service is intentionally
	 * left undefined here; applications should provide their own wiring.
	 */
	transport?: unknown;
}
