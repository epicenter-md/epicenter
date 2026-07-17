import type {
	RowSyncSqlite,
	SqliteValue,
	WireRowIntent,
} from '@epicenter/row-sync';
import type { Static, TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import {
	createDocumentRuntime,
	createLocalDocumentAdmission,
	type DocumentRuntime,
	type RowDocument,
} from './canonical-documents.js';
import { type CanonicalKv, createCanonicalKv } from './canonical-kv.js';
import {
	readCurrentDocumentParts,
	readCurrentRow,
} from './canonical-replica.js';
import type { CanonicalRows, CanonicalTable } from './canonical-rows.js';
import { createCanonicalRows } from './canonical-rows.js';
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

export type WorkspaceOwner<TAdmission extends void | Promise<void> = void> = {
	sqlite: RowSyncSqlite;
	/** Present only for synchronized files. */
	admitIntent?(intent: WireRowIntent): TAdmission;
	readCurrentRow?(
		table: string,
		rowId: string,
	): unknown | undefined | Promise<unknown | undefined>;
	readCurrentDocumentParts?(
		table: string,
		rowId: string,
	): Uint8Array[] | Promise<Uint8Array[]>;
	onLocalCommit?(): void;
	subscribeRowsDeleted?(
		listener: (addresses: { table: string; rowId: string }[]) => void,
	): () => void;
	/**
	 * Baseline promotion replaced every confirmed row and document
	 * (ADR-0136); the runtime revokes every live document handle so callers
	 * reopen from the promoted state.
	 */
	subscribeBaselinePromoted?(listener: () => void): () => void;
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
};

export type OpenedWorkspace<TDefinition extends WorkspaceDefinition> = {
	id: TDefinition['id'];
	tables: WorkspaceTables<DefinitionTables<TDefinition>>;
	kv: WorkspaceKv<DefinitionKv<TDefinition>>;
	sql: WorkspaceSql;
};

type OpenedOwner = {
	owner: WorkspaceOwner;
	rows: CanonicalRows;
	kv: CanonicalKv<KvDefinitions>;
	documents: DocumentRuntime;
};

type RuntimeEntry = {
	definition: WorkspaceDefinition;
	handle?: OpenedWorkspace<WorkspaceDefinition>;
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
						readCurrentRow(owner.sqlite, table, rowId));
				const currentDocumentParts =
					owner.readCurrentDocumentParts ??
					((table: string, rowId: string) =>
						readCurrentDocumentParts(owner.sqlite, table, rowId));
				const documents = createDocumentRuntime({
					admitIntent:
						owner.admitIntent ??
						createLocalDocumentAdmission({
							sqlite: owner.sqlite,
							readCurrentRow: (table, rowId) =>
								readCurrentRow(owner.sqlite, table, rowId),
							onLocalCommit: owner.onLocalCommit,
						}),
					readParts: currentDocumentParts,
					readCurrentRow: currentRow,
				});
				const rows = createCanonicalRows(
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
				owner.subscribeRowsDeleted?.(documents.revoke);
				owner.subscribeBaselinePromoted?.(documents.revokeAll);
				return { owner, rows, kv, documents };
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

	function createHandle<TDefinition extends WorkspaceDefinition>(
		definition: TDefinition,
		entry: RuntimeEntry,
	): OpenedWorkspace<TDefinition> {
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
		}) as WorkspaceKv<DefinitionKv<TDefinition>>;

		return Object.freeze({
			id: definition.id,
			tables: Object.freeze(tables),
			kv,
			async sql<TResultSchema extends TSchema>(
				query: string,
				parameters: readonly SqliteValue[],
				resultSchema: TResultSchema,
			) {
				return (await rowsFor(entry)).sql(query, parameters, resultSchema);
			},
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
				await openedFor(existing);
				return existing.handle as OpenedWorkspace<TDefinition>;
			}
			const entry: RuntimeEntry = { definition };
			entry.handle = createHandle(definition, entry);
			entries.set(definition.id, entry);
			try {
				await openedFor(entry);
				return entry.handle as OpenedWorkspace<TDefinition>;
			} catch (cause) {
				if (entries.get(definition.id) === entry) {
					entries.delete(definition.id);
				}
				entry.abortController?.abort(cause);
				throw cause;
			}
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
					result.value.documents.revokeAll(
						new Error('Workspace runtime is disposed'),
					);
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
