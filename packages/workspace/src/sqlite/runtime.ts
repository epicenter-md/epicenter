import type { WireRowIntent } from '@epicenter/row-sync';
import type { SqliteDatabase, SqliteValue } from '@epicenter/sqlite';
import type * as Y from '@y/y';
import type { Static, TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import { createNativeSqliteDocumentStore } from '../document-provider/native-sqlite.js';
import type {
	DocumentStore,
	RowAddress,
} from '../document-provider/persistence.js';
import {
	createRowDocumentRuntime,
	type RowDocument,
	type RowDocumentConnectionLease,
	type RowDocumentRuntime,
} from '../document-provider/runtime/index.js';
import {
	type LogicalWorkspaceCopy,
	withCapturedDocuments,
} from './canonical-addition.js';
import { type CanonicalKv, createCanonicalKv } from './canonical-kv.js';
import type { CanonicalRows, CanonicalTable } from './canonical-rows.js';
import { createCanonicalRows } from './canonical-rows.js';
import type {
	WorkspaceOwnerSync,
	WorkspaceSync,
} from './canonical-sync-supervisor.js';
import type {
	KvDefinitions,
	KvReadError,
	KvValues,
	KvWriteError,
} from './kv-definition.js';
import type {
	ConstrainedChanges,
	JsonObject,
	TableLensDefinition,
	TableLensDefinitions,
} from './lens-definition.js';
import { readLocalRow } from './local-workspace-storage.js';
import type { WorkspaceLens } from './workspace-lens.js';

export type WorkspaceOwner<TAdmission extends void | Promise<void> = void> = {
	sqlite: SqliteDatabase;
	/** Present only for synchronized files. */
	sync?: WorkspaceOwnerSync;
	/** Present only for synchronized files. */
	admitIntent?(intent: WireRowIntent): TAdmission;
	readCurrentRow?(table: string, rowId: string): JsonObject | undefined;
	/** Independent row-document provider. Scalar synchronization never supplies it. */
	documentStore?: DocumentStore;
	connectDocument?(
		address: RowAddress,
		document: Y.Doc,
	): RowDocumentConnectionLease<unknown>;
	onLocalCommit?(): void;
	subscribeRowsDeleted?(
		listener: (addresses: { table: string; rowId: string }[]) => void,
	): () => void;
	/** Revoke live document handles after complete-state acquisition promotes. */
	subscribeAcquisitionPromoted?(listener: () => void): () => void;
	[Symbol.asyncDispose](): Promise<void>;
};

export type WorkspaceOwnerFactory = (
	workspaceId: string,
	signal: AbortSignal,
) => Promise<WorkspaceOwner>;

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

export type WorkspaceSql = <TResultSchema extends TSchema>(
	query: string,
	parameters: readonly SqliteValue[],
	resultSchema: TResultSchema,
) => Promise<Static<TResultSchema>[]>;

type DefinitionTables<TDefinition> =
	TDefinition extends WorkspaceLens<infer TTables, KvDefinitions>
		? TTables
		: never;

type DefinitionKv<TDefinition> =
	TDefinition extends WorkspaceLens<TableLensDefinitions, infer TKv>
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
};

export type Workspace<TDefinition extends WorkspaceLens> = {
	readonly id: TDefinition['id'];
	readonly tables: WorkspaceTables<DefinitionTables<TDefinition>>;
	readonly kv: WorkspaceKv<DefinitionKv<TDefinition>>;
	readonly sql: WorkspaceSql;
	/** Account synchronization, or `null` for a local-only workspace. */
	readonly sync: WorkspaceSync | null;
};

type OpenedOwner = {
	owner: WorkspaceOwner;
	rows: CanonicalRows;
	kv: CanonicalKv<KvDefinitions>;
	documents: RowDocumentRuntime;
	sync: WorkspaceSync | null;
};

type RuntimeEntry = {
	definition: WorkspaceLens;
	handle?: Workspace<WorkspaceLens>;
	abortController?: AbortController;
	ownerPromise?: Promise<OpenedOwner>;
};

/** Create one runtime whose `open()` eagerly acquires its SQLite owner. */
export function createWorkspaceRuntime({
	openWorkspaceOwner,
}: {
	openWorkspaceOwner: WorkspaceOwnerFactory;
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
			const owner = await openWorkspaceOwner(
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
						readLocalRow(owner.sqlite, table, rowId));
				const documentStore =
					owner.documentStore ??
					createNativeSqliteDocumentStore({ database: owner.sqlite });
				const documents = createRowDocumentRuntime<unknown>({
					store: documentStore,
					isLive: ({ table, rowId }) => currentRow(table, rowId) !== undefined,
					...(owner.connectDocument ? { connect: owner.connectDocument } : {}),
				});
				const rows = createCanonicalRows(
					owner.sqlite,
					entry.definition.tables,
					{
						admitIntent: owner.admitIntent,
						readCurrentRow: currentRow,
						onLocalCommit: owner.onLocalCommit,
						onRowsDeleted(addresses) {
							for (const address of addresses) void documents.revoke(address);
						},
					},
				);
				const kv = createCanonicalKv(owner.sqlite, entry.definition.kv, {
					admitIntent: owner.admitIntent,
					readCurrentRow: currentRow,
					onLocalCommit: owner.onLocalCommit,
				});
				owner.subscribeRowsDeleted?.((addresses) => {
					for (const address of addresses) void documents.revoke(address);
				});
				owner.subscribeAcquisitionPromoted?.(documents.revokeAll);
				const sync = bindWorkspaceSync(owner.sync, async (copy) => {
					await documents.captureDurabilityBarrier();
					return withCapturedDocuments(copy, documentStore.capture);
				});
				return { owner, rows, kv, documents, sync };
			} catch (cause) {
				try {
					await owner[Symbol.asyncDispose]();
				} catch (disposeCause) {
					throw new AggregateError(
						[cause, disposeCause],
						'Workspace owner initialization and cleanup failed',
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

	async function rowsFor(entry: RuntimeEntry): Promise<CanonicalRows> {
		return (await openedFor(entry)).rows;
	}

	function createHandle<TDefinition extends WorkspaceLens>(
		definition: TDefinition,
		entry: RuntimeEntry,
		sync: WorkspaceSync | null,
	): Workspace<TDefinition> {
		const tables = Object.fromEntries(
			Object.keys(definition.tables).map((name) => [
				name,
				Object.freeze({
					async get(id: string) {
						return tableFor(await rowsFor(entry), name).get(id);
					},
					async list() {
						return tableFor(await rowsFor(entry), name).list();
					},
					async create(fields: Record<string, unknown>) {
						return tableFor(await rowsFor(entry), name).create(fields);
					},
					async update(id: string, changes: Record<string, unknown>) {
						return tableFor(await rowsFor(entry), name).update(id, changes);
					},
					async delete(id: string) {
						tableFor(await rowsFor(entry), name).delete(id);
					},
					document: Object.freeze({
						async open(rowId: string) {
							return (await openedFor(entry)).documents.open({
								table: name,
								rowId,
							});
						},
					}),
				}),
			]),
		) as unknown as WorkspaceTables<DefinitionTables<TDefinition>>;

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
		}) as WorkspaceKv<DefinitionKv<TDefinition>>;

		return Object.freeze({
			id: definition.id,
			tables: Object.freeze(tables),
			kv,
			sync,
			async sql<TResultSchema extends TSchema>(
				query: string,
				parameters: readonly SqliteValue[],
				resultSchema: TResultSchema,
			) {
				return (await rowsFor(entry)).sql(query, parameters, resultSchema);
			},
		}) as Workspace<TDefinition>;
	}

	return {
		async open<TDefinition extends WorkspaceLens>(
			definition: TDefinition,
		): Promise<Workspace<TDefinition>> {
			assertOpen();
			const existing = entries.get(definition.id);
			if (existing) {
				if (existing.definition !== definition) {
					throw new Error(
						`Workspace '${definition.id}' is already bound to another definition in this runtime`,
					);
				}
				const opened = await openedFor(existing);
				existing.handle ??= createHandle(definition, existing, opened.sync);
				return existing.handle as Workspace<TDefinition>;
			}
			const entry: RuntimeEntry = { definition };
			entries.set(definition.id, entry);
			try {
				const opened = await openedFor(entry);
				entry.handle = createHandle(definition, entry, opened.sync);
				return entry.handle as Workspace<TDefinition>;
			} catch (cause) {
				if (entries.get(definition.id) === entry) {
					entries.delete(definition.id);
				}
				entry.abortController?.abort(cause);
				throw cause;
			}
		},
		async captureDurability(workspaceId: string): Promise<void> {
			const entry = entries.get(workspaceId);
			if (!entry) throw new Error(`Workspace '${workspaceId}' is not open`);
			const opened = await openedFor(entry);
			await opened.documents.captureDurabilityBarrier();
		},
		/** Revoke every open row-document handle before destructive storage work. */
		async revokeDocuments(workspaceId: string, cause?: Error): Promise<void> {
			const entry = entries.get(workspaceId);
			if (!entry) throw new Error(`Workspace '${workspaceId}' is not open`);
			const opened = await openedFor(entry);
			await opened.documents.revokeAll(cause);
		},
		/** Apply portable Yjs 14 state as ordinary locally durable document work. */
		async importDocument(
			workspaceId: string,
			address: RowAddress,
			update: Uint8Array,
		): Promise<void> {
			const entry = entries.get(workspaceId);
			if (!entry) throw new Error(`Workspace '${workspaceId}' is not open`);
			const opened = await openedFor(entry);
			await opened.documents.importUpdate(address, update);
		},
		async whenReady(workspaceId: string): Promise<void> {
			const entry = entries.get(workspaceId);
			if (!entry) throw new Error(`Workspace '${workspaceId}' is not open`);
			const opened = await openedFor(entry);
			await opened.owner.sync?.whenReady();
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
				// Revoke cached row documents before the SQLite owner closes so
				// retained handles fail loudly instead of queueing persistence
				// against a disposed owner (ADR-0135).
				try {
					await result.value.documents[Symbol.asyncDispose]();
				} catch (cause) {
					failures.push(cause);
				}
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

function tableFor(
	records: CanonicalRows,
	name: string,
): CanonicalTable<TableLensDefinition> {
	const table = records.tables[name];
	if (!table) throw new Error(`Canonical table '${name}' is missing`);
	return table;
}

function bindWorkspaceSync(
	ownerSync: WorkspaceOwnerSync | undefined,
	captureDocuments: (
		copy: LogicalWorkspaceCopy,
	) => Promise<LogicalWorkspaceCopy>,
): WorkspaceSync | null {
	if (!ownerSync) return null;
	return Object.freeze({
		get status() {
			return ownerSync.status;
		},
		onStatusChange(listener) {
			return ownerSync.onStatusChange(listener);
		},
		settle() {
			return ownerSync.settleThrough(ownerSync.captureAdmissionCut());
		},
		async captureRecovery() {
			const copy = await ownerSync.captureRecovery();
			// The recovery copy carries each row's locally durable compact
			// document state (ADR-0142); the scalar replica owns only rows and KV.
			return copy === null ? null : captureDocuments(copy);
		},
		startFresh() {
			// This explicit recovery action discards the halted private lineage.
			// Local document logs deliberately survive it: same-address Yjs merge
			// is the document plane's ordinary convergence law, and conforming
			// runtimes never reuse a row address across lifetimes (ADR-0145).
			return ownerSync.startFresh();
		},
	});
}
