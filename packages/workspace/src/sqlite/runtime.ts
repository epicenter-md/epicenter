import type { WireRowIntent } from '@epicenter/row-sync';
import { RESERVED_KV_ROW_ID, RESERVED_KV_TABLE } from '@epicenter/row-sync';
import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import type * as Y from '@y/y';
import type { Static, TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import {
	createDocumentStore,
	type RowAddress,
} from '../document-provider/persistence.js';
import {
	createRowDocumentRuntime,
	type RowDocument,
	type RowDocumentConnectionLease,
	type RowDocumentRuntime,
} from '../document-provider/runtime/index.js';
import {
	createSqliteDocumentLog,
	type SqliteDocumentLog,
} from '../document-provider/sqlite-document-log.js';
import {
	type LogicalWorkspaceCopy,
	withCapturedDocuments,
} from './canonical-addition.js';
import {
	type CanonicalStore,
	createCanonicalStore,
} from './canonical-store.js';
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
	CreateInputFor,
	JsonObject,
	RowFor,
	RowLensError,
	TableLensDefinition,
	TableLensDefinitions,
} from './lens-definition.js';
import { readLocalRow } from './local-workspace-storage.js';
import { assertWorkspaceId, type WorkspaceLens } from './workspace-lens.js';
import { createWorkspaceView } from './workspace-view.js';

export type WorkspaceOwner<TAdmission extends void | Promise<void> = void> = {
	sqlite: SqliteDatabase;
	/** Present only for synchronized files. */
	sync?: WorkspaceOwnerSync;
	/** Present only for synchronized files. */
	admitIntent?(intent: WireRowIntent): TAdmission;
	readCurrentRow?(table: string, rowId: string): JsonObject | undefined;
	/** Owner-side row-document update log. Scalar synchronization never supplies it. */
	documentLog?: SqliteDocumentLog;
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
	get(
		id: string,
	): Promise<Result<RowFor<TDefinition> | undefined, RowLensError>>;
	list(): Promise<{
		rows: RowFor<TDefinition>[];
		nonconforming: RowLensError[];
	}>;
	create(fields: CreateInputFor<TDefinition>): Promise<RowFor<TDefinition>>;
	update<const TChanges extends Record<string, unknown>>(
		id: string,
		changes: TChanges & ConstrainedChanges<TDefinition, TChanges>,
	): Promise<Result<RowFor<TDefinition> | undefined, RowLensError>>;
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

type LensTables<TLens> =
	TLens extends WorkspaceLens<infer TTables, KvDefinitions> ? TTables : never;

type LensKv<TLens> =
	TLens extends WorkspaceLens<TableLensDefinitions, infer TKv> ? TKv : never;

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

export type Workspace<TLens extends WorkspaceLens> = {
	readonly id: TLens['id'];
	readonly tables: WorkspaceTables<LensTables<TLens>>;
	readonly kv: WorkspaceKv<LensKv<TLens>>;
	readonly sql: WorkspaceSql;
	/** Account synchronization, or `null` for a local-only workspace. */
	readonly sync: WorkspaceSync | null;
};

/** Schema-opaque ID-owned handle for transport hosts and other trust boundaries. */
export type RawWorkspace = {
	readonly id: string;
	read(table: string, rowId: string): JsonObject | undefined;
	list(table: string): { rowId: string; fields: JsonObject }[];
	admit(intent: WireRowIntent): void;
	sql(query: string, parameters: readonly SqliteValue[]): SqliteRow[];
	readonly document: {
		open(table: string, rowId: string): Promise<RowDocument<unknown>>;
	};
	/** Account synchronization, or `null` for a local-only workspace. */
	readonly sync: WorkspaceSync | null;
};

type OpenedOwner = {
	owner: WorkspaceOwner;
	store: CanonicalStore;
	documents: RowDocumentRuntime;
	sync: WorkspaceSync | null;
};

type RuntimeEntry = {
	id: string;
	views: Map<WorkspaceLens, Workspace<WorkspaceLens>>;
	raw?: RawWorkspace;
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
				entry.id,
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
				const documentLog =
					owner.documentLog ??
					createSqliteDocumentLog({
						database: owner.sqlite,
						isRowLive: ({ table, rowId }) =>
							currentRow(table, rowId) !== undefined,
					});
				const documents = createRowDocumentRuntime<unknown>({
					store: createDocumentStore({
						load: async (address) => documentLog.load(address),
						append: async (address, update) =>
							documentLog.append(address, update),
					}),
					isLive: ({ table, rowId }) => currentRow(table, rowId) !== undefined,
					...(owner.connectDocument ? { connect: owner.connectDocument } : {}),
				});
				const store = createCanonicalStore(owner.sqlite, {
					admitIntent: owner.admitIntent,
					readCurrentRow: currentRow,
					onLocalCommit: owner.onLocalCommit,
					deleteDocumentRows: documentLog.deleteRows,
					onRowsDeleted(addresses) {
						for (const address of addresses) void documents.revoke(address);
					},
				});
				owner.subscribeRowsDeleted?.((addresses) => {
					for (const address of addresses) void documents.revoke(address);
				});
				owner.subscribeAcquisitionPromoted?.(documents.revokeAll);
				const sync = bindWorkspaceSync(owner.sync, async (copy) => {
					await documents.captureDurabilityBarrier();
					return withCapturedDocuments(copy, async (address) =>
						documentLog.capture(address),
					);
				});
				return { owner, store, documents, sync };
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

	function createRaw(entry: RuntimeEntry, opened: OpenedOwner): RawWorkspace {
		return Object.freeze({
			id: entry.id,
			read(table: string, rowId: string) {
				assertOpen();
				return opened.store.read(table, rowId);
			},
			list(table: string) {
				assertOpen();
				return opened.store.list(table);
			},
			admit(intent: WireRowIntent) {
				assertOpen();
				opened.store.admit(intent);
			},
			sql(query: string, parameters: readonly SqliteValue[]) {
				assertOpen();
				return opened.store.sql(query, parameters);
			},
			document: Object.freeze({
				open(table: string, rowId: string) {
					assertOpen();
					return opened.documents.open({ table, rowId });
				},
			}),
			get sync() {
				assertOpen();
				return opened.sync;
			},
		});
	}

	function createView<TLens extends WorkspaceLens>(
		lens: TLens,
		raw: RawWorkspace,
	): Workspace<TLens> {
		return createWorkspaceView(lens, {
			read: raw.read,
			list: raw.list,
			readKvMap() {
				return raw.read(RESERVED_KV_TABLE, RESERVED_KV_ROW_ID) ?? {};
			},
			admit: raw.admit,
			sql: raw.sql,
			openDocument: raw.document.open,
			get sync() {
				return raw.sync;
			},
		});
	}

	async function openRaw(workspaceId: string): Promise<RawWorkspace> {
		assertOpen();
		assertWorkspaceId(workspaceId);
		let entry = entries.get(workspaceId);
		if (!entry) {
			entry = { id: workspaceId, views: new Map() };
			entries.set(workspaceId, entry);
		}
		if (entry.raw) return entry.raw;
		let opened: OpenedOwner;
		try {
			opened = await openedFor(entry);
		} catch (cause) {
			if (entries.get(workspaceId) === entry) entries.delete(workspaceId);
			entry.abortController?.abort(cause);
			throw cause;
		}
		entry.raw ??= createRaw(entry, opened);
		return entry.raw;
	}

	return {
		openRaw,
		async open<TLens extends WorkspaceLens>(
			lens: TLens,
		): Promise<Workspace<TLens>> {
			assertOpen();
			const existing = entries.get(lens.id);
			if (existing) {
				const cached = existing.views.get(lens);
				if (cached) return cached as Workspace<TLens>;
				const raw = await openRaw(lens.id);
				const raced = existing.views.get(lens);
				if (raced) return raced as Workspace<TLens>;
				const view = createView(lens, raw);
				existing.views.set(lens, view as Workspace<WorkspaceLens>);
				return view;
			}
			const raw = await openRaw(lens.id);
			const entry = entries.get(lens.id);
			if (!entry) throw new Error(`Workspace '${lens.id}' failed to open`);
			const raced = entry.views.get(lens);
			if (raced) return raced as Workspace<TLens>;
			const view = createView(lens, raw);
			entry.views.set(lens, view as Workspace<WorkspaceLens>);
			return view;
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
			// This explicit recovery action discards the halted private lineage,
			// including its row-document logs, in the replica's reset transaction.
			return ownerSync.startFresh();
		},
	});
}
