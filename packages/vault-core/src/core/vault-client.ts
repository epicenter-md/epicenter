import type {
	Adapter,
	CompatibleDB,
	EnsureAdaptersOK,
	JoinedSchema,
} from './adapter';
import type { VaultClientConfig } from './config';
export class VaultClient<
	TDatabase extends CompatibleDB<JoinedSchema<{ adapters: TAdapters }>>,
	TAdapters extends Adapter[],
> {
	private declare readonly _ensureAdaptersOK: EnsureAdaptersOK<TAdapters>;
	readonly adapters: TAdapters;
	readonly transport: unknown;

	constructor(config: VaultClientConfig<TAdapters>) {
		this.adapters = config.adapters;
		this.transport = config.transport;
	}

	/**
	 * Ask service to import a blob with a given importer.
	 * Placeholder: must be implemented in host app via RPC.
	 */
	async importBlob(
		_adapterId: TAdapters[number]['id'],
		_file: Blob,
	): Promise<void> {
		throw new Error(
			'VaultClient.importBlob not implemented: provide RPC transport',
		);
	}

	/**
	 * Query the database using a SQL builder function.
	 * @example
	 * const result = await client.querySQL((db, tables) =>
	 * 	db.select().from(tables.users).where(equals(tables.users.id, 1))
	 * );
	 */
	async querySQL(
		builder: (
			db: TDatabase,
			tables: JoinedSchema<this>,
		) => Pick<TDatabase, '_' | 'select'>,
	) {
		throw new Error(
			'VaultClient.querySQL not implemented: provide RPC transport',
		);
	}
}
