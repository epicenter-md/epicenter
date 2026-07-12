/**
 * Async workspace service over the synchronous application database.
 *
 * Browser workers and native hosts expose this port to async clients. One
 * mutate request becomes one SQLite transaction; the committed event is
 * materialized from post-commit database state before the request resolves.
 */

import type {
	TableCommitDelta,
	WorkspaceCommitDelta,
	WorkspaceMutation,
	WorkspaceServicePort,
	WorkspaceServiceRequest,
	WorkspaceServiceResponse,
} from './client.js';
import type {
	ApplicationDatabase,
	ApplicationTable,
	CommittedApplicationChanges,
} from './database.js';
import type { KvDefinitions, TableDefinitions } from './definition.js';
import type { WorkspaceInvalidation } from './service-protocol.js';

type UntypedRow = { id: string } & Record<string, unknown>;
type UntypedTable = ApplicationTable<UntypedRow>;
type UntypedKv = {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
	clear(key: string): void;
};

export type WorkspaceServiceOptions = {
	/** Receives observer failures. Must not throw. */
	onObserverError(error: unknown): void;
};

type WorkspaceServiceRuntime = WorkspaceServicePort &
	Disposable & {
		refresh(invalidation: WorkspaceInvalidation): Promise<void>;
		observeChanges(
			callback: (
				delta: WorkspaceCommitDelta,
				source: 'commit' | 'refresh',
			) => void,
		): () => void;
	};

export function createWorkspaceService<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	database: ApplicationDatabase<TTables, TKv>,
	{ onObserverError }: WorkspaceServiceOptions,
) {
	const definition = database.definition;
	const observers = new Set<(delta: WorkspaceCommitDelta) => void>();
	const changeObservers = new Set<
		(delta: WorkspaceCommitDelta, source: 'commit' | 'refresh') => void
	>();
	const tables = database.tables as unknown as Record<string, UntypedTable>;
	const kv = database.kv as unknown as UntypedKv;
	let requestTail: Promise<void> = Promise.resolve();
	let isDisposed = false;

	function assertOpen(): void {
		if (isDisposed) throw new Error('Workspace service is disposed');
	}

	function tableFor(name: string): UntypedTable {
		const table = tables[name];
		if (!table || !Object.hasOwn(definition.tables, name)) {
			throw new Error(`Unknown workspace table '${name}'`);
		}
		return table;
	}

	function assertKvKey(key: string): void {
		if (!Object.hasOwn(definition.kv, key))
			throw new Error(`Unknown workspace KV key '${key}'`);
	}

	function notify(
		delta: WorkspaceCommitDelta,
		source: 'commit' | 'refresh',
	): void {
		for (const observer of [...observers]) {
			try {
				observer(structuredClone(delta));
			} catch (cause) {
				try {
					onObserverError(cause);
				} catch {
					// A broken error sink must not make a committed command look failed.
				}
			}
		}
		for (const observer of [...changeObservers]) {
			try {
				observer(structuredClone(delta), source);
			} catch (cause) {
				try {
					onObserverError(cause);
				} catch {
					// A broken error sink must not make committed state look failed.
				}
			}
		}
	}

	const stopDatabaseObserver = database.observe((changes) => {
		notify(materializeDelta(changes, tables, kv), 'commit');
	});

	function applyMutation(
		mutation: WorkspaceMutation,
		tx: {
			tables: Record<string, UntypedTable>;
			kv: UntypedKv;
		},
	): unknown {
		function transactionTable(name: string): UntypedTable {
			tableFor(name);
			const table = tx.tables[name];
			if (!table)
				throw new Error(`Transaction has no workspace table '${name}'`);
			return table;
		}
		switch (mutation.kind) {
			case 'put':
				transactionTable(mutation.table).put(mutation.row as UntypedRow);
				return null;
			case 'patch':
				return transactionTable(mutation.table).patch(
					mutation.rowId,
					mutation.cells,
				);
			case 'remove':
				transactionTable(mutation.table).remove(mutation.rowId);
				return null;
			case 'setKv':
				assertKvKey(mutation.key);
				tx.kv.set(mutation.key, mutation.value);
				return null;
			case 'clearKv':
				assertKvKey(mutation.key);
				tx.kv.clear(mutation.key);
				return null;
			default:
				mutation satisfies never;
				throw new Error('Unknown workspace mutation');
		}
	}

	function executeRequest(
		request: WorkspaceServiceRequest,
	): WorkspaceServiceResponse {
		assertOpen();
		switch (request.kind) {
			case 'describe':
				return {
					kind: 'workspace',
					workspaceKind: database.identity.kind,
					workspaceId: database.identity.workspaceId,
					schemaIdentity: database.identity.schemaIdentity,
				};
			case 'get':
				return { kind: 'row', row: tableFor(request.table).get(request.rowId) };
			case 'list':
				return {
					kind: 'rows',
					rows: tableFor(request.table).list(
						request.options as Parameters<UntypedTable['list']>[0],
					),
				};
			case 'has':
				return {
					kind: 'boolean',
					value: tableFor(request.table).has(request.rowId),
				};
			case 'count':
				return { kind: 'count', value: tableFor(request.table).count() };
			case 'getKv':
				assertKvKey(request.key);
				return { kind: 'value', value: kv.get(request.key) };
			case 'mutate':
				return {
					kind: 'mutation',
					results: database.transact((tx) =>
						request.mutations.map((mutation) =>
							applyMutation(mutation, {
								tables: tx.tables as unknown as Record<string, UntypedTable>,
								kv: tx.kv as unknown as UntypedKv,
							}),
						),
					),
				};
			default:
				request satisfies never;
				throw new Error('Unknown workspace service request');
		}
	}

	function request(
		serviceRequest: WorkspaceServiceRequest,
	): Promise<WorkspaceServiceResponse> {
		let capturedRequest: WorkspaceServiceRequest;
		try {
			assertOpen();
			capturedRequest = structuredClone(serviceRequest);
		} catch (cause) {
			return Promise.reject(cause);
		}
		return enqueue(() => executeRequest(capturedRequest));
	}

	function enqueue<TResult>(run: () => TResult): Promise<TResult> {
		const response = requestTail.then(run);
		requestTail = response.then(
			() => undefined,
			() => undefined,
		);
		return response;
	}

	function refresh(invalidation: WorkspaceInvalidation): Promise<void> {
		let captured: WorkspaceInvalidation;
		try {
			assertOpen();
			captured = structuredClone(invalidation);
		} catch (cause) {
			return Promise.reject(cause);
		}
		return enqueue(() => {
			assertOpen();
			const changes: CommittedApplicationChanges = {
				tables: new Map(
					Object.entries(captured.tables).map(([table, ids]) => [
						table,
						new Set(ids),
					]),
				),
				kv: new Set(captured.kv),
			};
			notify(materializeDelta(changes, tables, kv), 'refresh');
		});
	}

	return {
		request,
		refresh,
		observe(callback: (delta: WorkspaceCommitDelta) => void) {
			assertOpen();
			observers.add(callback);
			return () => {
				observers.delete(callback);
			};
		},
		observeChanges(
			callback: (
				delta: WorkspaceCommitDelta,
				source: 'commit' | 'refresh',
			) => void,
		) {
			assertOpen();
			changeObservers.add(callback);
			return () => {
				changeObservers.delete(callback);
			};
		},
		[Symbol.dispose]() {
			if (isDisposed) return;
			isDisposed = true;
			stopDatabaseObserver();
			observers.clear();
			changeObservers.clear();
		},
	} satisfies WorkspaceServiceRuntime;
}

export type WorkspaceService<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = ReturnType<typeof createWorkspaceService<TTables, TKv>>;

function materializeDelta(
	changes: CommittedApplicationChanges,
	tables: Record<string, UntypedTable>,
	kv: UntypedKv,
): WorkspaceCommitDelta {
	const tableDeltas: Record<string, TableCommitDelta> = {};
	for (const [tableName, changedIds] of changes.tables) {
		const table = tables[tableName];
		if (!table)
			throw new Error(`Committed unknown workspace table '${tableName}'`);
		const upserted: UntypedRow[] = [];
		const removed: string[] = [];
		for (const id of changedIds) {
			const row = table.get(id);
			if (row) upserted.push(row);
			else removed.push(id);
		}
		tableDeltas[tableName] = { upserted, removed };
	}

	const kvDelta: Record<string, unknown> = {};
	for (const key of changes.kv) kvDelta[key] = kv.get(key);
	return { tables: tableDeltas, kv: kvDelta };
}
