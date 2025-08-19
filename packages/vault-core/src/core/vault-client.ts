import type { Adapter } from './adapter';
import type { VaultClientConfig } from './config';
/**
 * VaultClient runs in the app (web/desktop). It holds adapters for type-safety
 * and schema/metadata introspection. It talks to VaultService via RPC (not implemented).
 */
export class VaultClient<TAdapters extends Adapter[]> {
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
}
