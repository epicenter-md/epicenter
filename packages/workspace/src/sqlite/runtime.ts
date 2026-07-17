import {
	decodeBase64,
	type RowSyncSqlite,
	type SqliteValue,
	type WireRowIntent,
} from '@epicenter/row-sync';
import type { Static, TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import {
	createDocumentRuntime,
	type DocumentRuntime,
	mergeDocumentUpdates,
	type RowDocument,
} from './canonical-documents.js';
import { type CanonicalKv, createCanonicalKv } from './canonical-kv.js';
import type { CanonicalRecords, CanonicalTable } from './canonical-records.js';
import { createCanonicalRecords } from './canonical-records.js';
import {
	readCurrentDocumentParts,
	readCurrentRow,
} from './canonical-replica.js';
import type {
	KvDefinitions,
	KvReadError,
	KvValues,
	KvWriteError,
} from './kv-definition.js';
import type {
	ConstrainedChanges,
	TableLensDefinition,
	TableLensDefinitions,
} from './lens-definition.js';
import type { WorkspaceDefinition } from './runtime-definition.js';

export type WorkspaceRecordOwner = {
	sqlite: RowSyncSqlite;
	/** Present only for synchronized files. */
	admitIntent?(intent: WireRowIntent): void;
	readCurrentRow?(table: string, rowId: string): unknown | undefined;
	readCurrentDocumentParts?(table: string, rowId: string): Uint8Array[];
	onLocalCommit?(): void;
	subscribeRemoteCommit?(listener: () => void): () => void;
	subscribeRowsDeleted?(
		listener: (addresses: { table: string; rowId: string }[]) => void,
	): () => void;
	[Symbol.asyncDispose](): Promise<void>;
};

export type WorkspaceRecordOwnerFactory = (
	workspaceId: string,
	signal: AbortSignal,
) => Promise<WorkspaceRecordOwner>;

type AsyncCanonicalTable<TDefinition extends TableLensDefinition> = {
	get(id: string): Promise<ReturnType<CanonicalTable<TDefinition>['get']>>;
	list(): Promise<ReturnType<CanonicalTable<TDefinition>['list']>>;
	create(
		fields: Parameters<CanonicalTable<TDefinition>['create']>[0],
	): Promise<ReturnType<CanonicalTable<TDefinition>['create']>>;
	update<const TChanges extends Record<string, unknown>>(
		id: string,
		changes: TChanges & ConstrainedChanges<TDefinition, TChanges>,
	): Promise<ReturnType<CanonicalTable<TDefinition>['get']>>;
	delete(id: string): Promise<void>;
	document: { open(rowId: string): Promise<RowDocument> };
};

export type WorkspaceTables<TTables extends TableLensDefinitions> = {
	[K in keyof TTables]: AsyncCanonicalTable<TTables[K]>;
};

export type WorkspaceRecords = {
	sql<TResultSchema extends TSchema>(
		query: string,
		parameters: readonly SqliteValue[],
		resultSchema: TResultSchema,
	): Promise<Static<TResultSchema>[]>;
};

type DefinitionTables<TDefinition> =
	TDefinition extends WorkspaceDefinition<infer TTables, KvDefinitions>
		? TTables
		: never;

type DefinitionKv<TDefinition> =
	TDefinition extends WorkspaceDefinition<TableLensDefinitions, infer TKv>
		? TKv
		: never;

export type WorkspaceKv<TKv extends KvDefinitions> = {
	get<K extends keyof TKv & string>(
		key: K,
	): Promise<Result<KvValues<TKv>[K] | undefined, KvReadError>>;
	set<K extends keyof TKv & string>(
		key: K,
		value: KvValues<TKv>[K],
	): Promise<Result<void, KvWriteError>>;
	unset<K extends keyof TKv & string>(key: K): Promise<void>;
	observe<K extends keyof TKv & string>(
		key: K,
		handler: () => void,
	): () => void;
};

export type OpenedWorkspace<TDefinition extends WorkspaceDefinition> = {
	id: TDefinition['id'];
	tables: WorkspaceTables<DefinitionTables<TDefinition>>;
	kv: WorkspaceKv<DefinitionKv<TDefinition>>;
	records: WorkspaceRecords;
};

type OpenedOwner = {
	owner: WorkspaceRecordOwner;
	records: CanonicalRecords;
	kv: CanonicalKv<KvDefinitions>;
	documents: DocumentRuntime;
};

type RuntimeEntry = {
	definition: WorkspaceDefinition;
	handle?: OpenedWorkspace<WorkspaceDefinition>;
	abortController?: AbortController;
	ownerPromise?: Promise<OpenedOwner>;
};

/** Create one runtime whose workspace SQLite owners open lazily. */
export function createWorkspaceRuntime({
	openRecordOwner,
}: {
	openRecordOwner: WorkspaceRecordOwnerFactory;
}) {
	const entries = new Map<string, RuntimeEntry>();
	let isDisposed = false;

	function assertOpen(): void {
		if (isDisposed) throw new Error('Workspace runtime is disposed');
	}

	async function openedFor(entry: RuntimeEntry): Promise<OpenedOwner> {
		assertOpen();
		entry.abortController ??= new AbortController();
		entry.ownerPromise ??= (async () => {
			const owner = await openRecordOwner(
				entry.definition.id,
				entry.abortController?.signal ?? AbortSignal.abort(),
			);
			try {
				if (isDisposed) {
					throw new Error(
						'Workspace runtime was disposed while records opened',
					);
				}
				const currentRow =
					owner.readCurrentRow ??
					((table: string, rowId: string) =>
						readCurrentRow(owner.sqlite, table, rowId));
				const currentDocumentParts =
					owner.readCurrentDocumentParts ??
					((table: string, rowId: string) =>
						readCurrentDocumentParts(owner.sqlite, table, rowId));
				const documents = createDocumentRuntime({
					sqlite: owner.sqlite,
					admitIntent:
						owner.admitIntent ??
						createLocalDocumentAdmission(
							owner.sqlite,
							currentRow,
							owner.onLocalCommit,
						),
					readParts: currentDocumentParts,
					readCurrentRow: currentRow,
				});
				const records = createCanonicalRecords(
					owner.sqlite,
					entry.definition.tables,
					{
						admitIntent: owner.admitIntent,
						onLocalCommit: owner.onLocalCommit,
						onRowsDeleted: documents.revoke,
					},
				);
				const kv = createCanonicalKv(owner.sqlite, entry.definition.kv, {
					admitIntent: owner.admitIntent,
					onLocalCommit: owner.onLocalCommit,
				});
				owner.subscribeRemoteCommit?.(() => kv.notifyExternalChange());
				owner.subscribeRowsDeleted?.(documents.revoke);
				return { owner, records, kv, documents };
			} catch (cause) {
				try {
					await owner[Symbol.asyncDispose]();
				} catch (disposeCause) {
					throw new AggregateError(
						[cause, disposeCause],
						'Workspace record owner initialization and cleanup failed',
					);
				}
				throw cause;
			}
		})().catch((cause) => {
			entry.ownerPromise = undefined;
			throw cause;
		});
		return entry.ownerPromise;
	}

	async function recordsFor(entry: RuntimeEntry): Promise<CanonicalRecords> {
		return (await openedFor(entry)).records;
	}

	function createHandle<TDefinition extends WorkspaceDefinition>(
		definition: TDefinition,
		entry: RuntimeEntry,
	): OpenedWorkspace<TDefinition> {
		const tables = Object.fromEntries(
			Object.keys(definition.tables).map((name) => [
				name,
				Object.freeze({
					async get(id: string) {
						return tableFor(await recordsFor(entry), name).get(id);
					},
					async list() {
						return tableFor(await recordsFor(entry), name).list();
					},
					async create(fields: Record<string, unknown>) {
						return tableFor(await recordsFor(entry), name).create(fields);
					},
					async update(id: string, changes: Record<string, unknown>) {
						return tableFor(await recordsFor(entry), name).update(id, changes);
					},
					async delete(id: string) {
						tableFor(await recordsFor(entry), name).delete(id);
					},
					document: Object.freeze({
						async open(rowId: string) {
							return (await openedFor(entry)).documents.open(name, rowId);
						},
					}),
				}),
			]),
		) as WorkspaceTables<DefinitionTables<TDefinition>>;

		const kv = Object.freeze({
			async get(key: string) {
				return (await openedFor(entry)).kv.get(key);
			},
			async set(key: string, value: never) {
				return (await openedFor(entry)).kv.set(key, value);
			},
			async unset(key: string) {
				(await openedFor(entry)).kv.unset(key);
			},
			observe(key: string, handler: () => void) {
				let disposed = false;
				let detach: (() => void) | undefined;
				void openedFor(entry).then((opened) => {
					if (disposed) return;
					detach = opened.kv.observe(key, handler);
				});
				return () => {
					disposed = true;
					detach?.();
				};
			},
		}) as WorkspaceKv<DefinitionKv<TDefinition>>;

		return Object.freeze({
			id: definition.id,
			tables: Object.freeze(tables),
			kv,
			records: Object.freeze({
				async sql<TResultSchema extends TSchema>(
					query: string,
					parameters: readonly SqliteValue[],
					resultSchema: TResultSchema,
				) {
					return (await recordsFor(entry)).sql(query, parameters, resultSchema);
				},
			}),
		}) as OpenedWorkspace<TDefinition>;
	}

	return {
		async open<TDefinition extends WorkspaceDefinition>(
			definition: TDefinition,
		): Promise<OpenedWorkspace<TDefinition>> {
			assertOpen();
			const existing = entries.get(definition.id);
			if (existing) {
				if (existing.definition !== definition) {
					throw new Error(
						`Workspace '${definition.id}' is already bound to another definition in this runtime`,
					);
				}
				if (!existing.handle) {
					throw new Error(`Workspace '${definition.id}' has no runtime handle`);
				}
				return existing.handle as OpenedWorkspace<TDefinition>;
			}
			const entry: RuntimeEntry = { definition };
			entry.handle = createHandle(definition, entry);
			entries.set(definition.id, entry);
			return entry.handle as OpenedWorkspace<TDefinition>;
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			for (const entry of entries.values()) entry.abortController?.abort();
			const owners = [...entries.values()].flatMap((entry) =>
				entry.ownerPromise ? [entry.ownerPromise] : [],
			);
			entries.clear();
			const results = await Promise.allSettled(owners);
			const failures: unknown[] = [];
			for (const result of results) {
				if (result.status !== 'fulfilled') continue;
				try {
					await result.value.owner[Symbol.asyncDispose]();
				} catch (cause) {
					failures.push(cause);
				}
			}
			if (failures.length > 0) {
				throw new AggregateError(failures, 'Workspace runtime disposal failed');
			}
		},
	};
}

export type WorkspaceRuntime = ReturnType<typeof createWorkspaceRuntime>;

function createLocalDocumentAdmission(
	sqlite: RowSyncSqlite,
	currentRow: (table: string, rowId: string) => unknown | undefined,
	onLocalCommit: (() => void) | undefined,
): (intent: WireRowIntent) => void {
	return (intent) => {
		if (intent.kind !== 'update' || intent.documentUpdate === undefined) {
			throw new TypeError(
				'Local document persistence requires an update intent',
			);
		}
		sqlite.transaction(() => {
			if (currentRow(intent.table, intent.rowId) === undefined) return;
			const incoming = decodeBase64(intent.documentUpdate as string);
			const stored = sqlite.all<{ yjs_state: Uint8Array }>(
				`SELECT yjs_state FROM documents
				 WHERE table_key = ? AND row_id = ?`,
				[intent.table, intent.rowId],
			)[0];
			const merged = mergeDocumentUpdates(
				stored ? [toBytes(stored.yjs_state), incoming] : [incoming],
			);
			sqlite.run(
				`INSERT INTO documents(table_key, row_id, yjs_state)
				 VALUES (?, ?, ?)
				 ON CONFLICT(table_key, row_id) DO UPDATE SET
					yjs_state = excluded.yjs_state`,
				[intent.table, intent.rowId, merged],
			);
			onLocalCommit?.();
		});
	};
}

function toBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
	return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function tableFor(
	records: CanonicalRecords,
	name: string,
): CanonicalTable<TableLensDefinition> {
	const table = records.tables[name];
	if (!table) throw new Error(`Canonical table '${name}' is missing`);
	return table;
}
