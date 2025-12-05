import type { MigrationConfig } from 'drizzle-orm/migrator';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { Adapter } from './adapter';

export interface VaultConfig<
	TDatabase extends BaseSQLiteDatabase<'sync' | 'async', unknown>,
	TAdapters extends Adapter[],
> {
	/**
	 * List of adapters to include
	 *
	 * @see {Adapter}
	 */
	adapters: TAdapters;

	/**
	 * Database connection instance
	 * @example
	 * import { createClient } from '@libsql/client';
	 * const client = createClient({ url: dbUrl });
	 * const db = drizzle(client);
	 * ...
	 * database: db,
	 */
	database: TDatabase;

	/**
	 * Drizzle platform-specific migration function
	 * @example
	 * import { migrate } from 'drizzle-orm/libsql/migrator';
	 * ...
	 * migrateFunc: migrate,
	 * @see {MigrationConfig}
	 * @todo Implement in-house migration procedure, which doesn't rely on `node:fs`.
	 */
	migrateFunc: (db: TDatabase, config: MigrationConfig) => Promise<void>;
}
