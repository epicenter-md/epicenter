/**
 * Wire the folder to a live Epicenter runtime.
 *
 * Everything below this file is pure or filesystem-only, which is what made it
 * testable before a host existed. This is the one place that knows about bound
 * table handles, and it stays deliberately thin: resolve an address to a table,
 * read a row, write a row, and forward the committed-address stream.
 */

import type {
	JsonObject,
	Lens,
	RowAddress,
	TableDefinition,
} from '@epicenter/lens';

import type { FolderWriter } from './push.js';
import type { ReceiptStore } from './receipts.js';
import { renderIntoFolder } from './render-into.js';
import type { TableLookup } from './scan.js';

/**
 * What the folder needs from a host, structurally.
 *
 * Satisfied by `DesktopEpicenterOwner` without importing it. The committed
 * stream arrives through the owner's public `subscribeInvalidations` rather than
 * the symbol behind it, which is not on `@epicenter/data`'s barrel and is not
 * the folder's to reach for: `server.ts` already forwards it the same way.
 */
export type FolderSource = {
	epicenter: {
		bind(lens: Lens<Record<string, TableDefinition>>): Record<string, unknown>;
	};
	subscribeInvalidations(
		listener: (changes: readonly RowAddress[]) => void,
	): () => void;
};

type BoundTable = {
	create(fields: Record<string, unknown>): Promise<{ id: string }>;
	get(id: string): Promise<{ data?: Record<string, unknown> | undefined }>;
	patch(id: string, changes: Record<string, unknown>): Promise<unknown>;
	delete(id: string): Promise<boolean>;
};

export type FolderBridge = {
	lookup: TableLookup;
	/** The row's fields now, or undefined if no such row is alive. */
	read(address: RowAddress): Promise<JsonObject | undefined>;
	writer: FolderWriter;
	/** Every address the replica commits, batched per commit. */
	subscribe(listener: (addresses: readonly RowAddress[]) => void): () => void;
};

/**
 * Bind every Lens this host holds and index it by address.
 *
 * `bind` is called once per Lens rather than per access, because a bound handle
 * is the runtime's unit of identity and rebinding on every render would discard
 * whatever it caches.
 */
export function createFolderBridge({
	source,
	lenses,
}: {
	source: FolderSource;
	lenses: readonly Lens<Record<string, TableDefinition>>[];
}): FolderBridge {
	const tables = new Map<string, BoundTable>();
	const definitions = new Map<string, TableDefinition>();

	for (const lens of lenses) {
		const bound = source.epicenter.bind(lens) as Record<string, BoundTable>;
		for (const [tableName, definition] of Object.entries(lens.tables)) {
			const key = `${lens.namespace}/${tableName}`;
			const table = bound[tableName];
			if (table !== undefined) tables.set(key, table);
			definitions.set(key, definition);
		}
	}

	const tableFor = (address: RowAddress) =>
		tables.get(`${address.namespace}/${address.tableName}`);

	return {
		lookup: (namespace, tableName) =>
			definitions.get(`${namespace}/${tableName}`),

		async read(address) {
			const table = tableFor(address);
			if (table === undefined) return undefined;
			const row = (await table.get(address.rowId)).data;
			if (row === undefined) return undefined;
			// `id` is structural, not a field, and a table cannot declare one
			// (`defineTable` refuses it), so dropping it here is total.
			const { id: _id, ...fields } = row;
			return fields as JsonObject;
		},

		writer: {
			async create(namespace, tableName, fields) {
				const table = tables.get(`${namespace}/${tableName}`);
				if (table === undefined) {
					throw new Error(`No table bound at ${namespace}/${tableName}`);
				}
				return (await table.create(fields)).id;
			},
			async patch(address, changes) {
				const table = tableFor(address);
				if (table === undefined) return false;
				// `patch` resolves to `undefined` when the row is not alive, which is
				// the vanished-row report rather than a resurrection (ADR-0206).
				const result = (await table.patch(address.rowId, changes)) as {
					data?: unknown;
				};
				return result.data !== undefined && result.data !== null;
			},
			async remove(address) {
				const table = tableFor(address);
				return table === undefined ? false : table.delete(address.rowId);
			},
		},

		subscribe(listener) {
			return source.subscribeInvalidations(listener);
		},
	};
}

/**
 * Keep the folder current for as long as this runs.
 *
 * One render per committed address, in order. Rendering is what records the
 * receipt, so a row that changes while you have an unpushed edit updates the
 * fields you did not touch and leaves the ones you did (ADR-0207).
 */
export function startFolderRenderer({
	root,
	receipts,
	bridge,
	onError = () => undefined,
}: {
	root: string;
	receipts: ReceiptStore;
	bridge: FolderBridge;
	onError?: (cause: unknown) => void;
}): () => void {
	// Serialized rather than concurrent: two renders of one row would race on the
	// same file and the same receipt, and a folder is never the hot path.
	let queue: Promise<void> = Promise.resolve();

	return bridge.subscribe((addresses) => {
		queue = queue
			.then(async () => {
				for (const address of addresses) {
					const definition = bridge.lookup(
						address.namespace,
						address.tableName,
					);
					if (definition === undefined) continue;
					renderIntoFolder({
						root,
						receipts,
						address,
						fields: await bridge.read(address),
						definition,
					});
				}
			})
			.catch(onError);
	});
}
