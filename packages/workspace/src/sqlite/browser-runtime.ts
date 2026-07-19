import {
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
	sha256Hex,
	type WireRowIntent,
} from '@epicenter/row-sync';
import type { SqliteValue } from '@epicenter/sqlite';
import { customAlphabet } from 'nanoid';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { Ok } from 'wellcrafted/result';
import { createBrowserIndexedDbDocumentStore } from '../document-provider/browser-indexed-db.js';
import {
	attachAuthenticatedDocumentConnection,
	type DocumentConnection,
	rowDocumentWebSocketUrl,
} from '../document-provider/connection/index.js';
import type { DocumentStore } from '../document-provider/persistence.js';
import { createRowDocumentRuntime } from '../document-provider/runtime/index.js';

import {
	accountBrowserPersistenceKey,
	deviceBrowserPersistenceKey,
	type WorkspaceAccount,
} from './account-runtime.js';
import type {
	BrowserRecordOperation,
	BrowserRowSyncBinding,
	BrowserRuntimeMessage,
	BrowserRuntimeRequest,
	BrowserWorkspaceManifest,
} from './browser-runtime-protocol.js';
import {
	type LogicalWorkspaceCopy,
	type LogicalWorkspaceExport,
	withCapturedDocuments,
} from './canonical-addition.js';
import type {
	WorkspaceSync,
	WorkspaceSyncSettlement,
	WorkspaceSyncStatus,
} from './canonical-sync-supervisor.js';
import { CurrentStateTransportInterruption } from './current-state-transport.js';
import {
	compileKvLens,
	type KvDefinitions,
	KvReadError,
	KvWriteError,
} from './kv-definition.js';
import { compileTableLens, type JsonObject } from './lens-definition.js';
import type { Workspace, WorkspaceTables } from './runtime.js';
import type { WorkspaceLens } from './workspace-lens.js';

type DefinitionTables<TDefinition> =
	TDefinition extends WorkspaceLens<infer TTables> ? TTables : never;

type PendingRequest = {
	resolve(value: unknown): void;
	reject(cause: unknown): void;
};

type BoundWorkspace = {
	manifest: BrowserWorkspaceManifest;
	views: Map<WorkspaceLens, Promise<Workspace<WorkspaceLens>>>;
	/** The one storage-opening attempt. */
	opened: Promise<void>;
	sync: WorkspaceSync | null;
	createView<TDefinition extends WorkspaceLens>(
		definition: TDefinition,
	): Workspace<TDefinition>;
	notifyRowsDeleted(addresses: RowAddress[]): void;
	notifySyncStatus(status: WorkspaceSyncStatus): void;
	notifyReady(): void;
	waitUntilReady(): Promise<void>;
	rejectReadiness(cause: Error): void;
	revokeDocuments(cause: Error): Promise<void>;
	captureDurability(): Promise<void>;
	disposeDocuments(): Promise<void>;
	deleteDocuments(): Promise<void>;
	captureDocuments(copy: LogicalWorkspaceCopy): Promise<LogicalWorkspaceCopy>;
	importDocuments(copy: LogicalWorkspaceCopy): Promise<void>;
};

const ROW_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const mintRowId = customAlphabet(ROW_ID_ALPHABET, 24);

type RowAddress = { table: string; rowId: string };

type InvalidationMessage = { type: 'records-changed'; workspaceId: string };

type BrowserRecordFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

type RuntimeBroadcastChannel = {
	onmessage: ((event: MessageEvent<unknown>) => void) | null;
	postMessage(message: unknown): void;
	close(): void;
};

export type BrowserWorkspaceTransport = {
	baseUrl: string;
	fetch?: BrowserRecordFetch;
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	headers?: Readonly<Record<string, string>>;
	credentials?: RequestCredentials;
	/** Scalar poll cadence override; production keeps the 30s default. */
	pollIntervalMs?: number;
};

export type BrowserWorkspaceAccount =
	WorkspaceAccount<BrowserWorkspaceTransport>;

type CreateBrowserWorkspaceRuntimeOptions = {
	persistenceKey: string;
	transport?: BrowserWorkspaceTransport;
	createBroadcastChannel?(name: string): RuntimeBroadcastChannel | undefined;
	onRecordsChanged?(workspaceId: string): void;
	onBackgroundError?(cause: Error, workspaceId: string): void;
};

export function createDeviceBrowserWorkspaceRuntime({
	createBroadcastChannel,
	onRecordsChanged,
	onBackgroundError,
}: Omit<
	CreateBrowserWorkspaceRuntimeOptions,
	'persistenceKey' | 'transport'
> = {}) {
	const runtime = createBrowserRuntimeWithPersistence({
		persistenceKey: deviceBrowserPersistenceKey(),
		createBroadcastChannel,
		onRecordsChanged,
		onBackgroundError,
	});
	return Object.freeze({
		open: runtime.open,
		async capture(definition: WorkspaceLens) {
			await runtime.open(definition);
			await runtime.captureDurability(definition.id);
			return runtime.captureLocal(definition.id);
		},
		/** A Device export is the local capture; there is no authority to settle. */
		async export(definition: WorkspaceLens): Promise<LogicalWorkspaceExport> {
			await runtime.open(definition);
			await runtime.captureDurability(definition.id);
			return {
				settlement: null,
				...(await runtime.captureLocal(definition.id)),
			};
		},
		async delete(definition: WorkspaceLens) {
			await runtime.open(definition);
			return runtime.deleteLocal(definition.id);
		},
		[Symbol.asyncDispose]: runtime[Symbol.asyncDispose],
	});
}

export function createAccountBrowserWorkspaceRuntime({
	account,
	createBroadcastChannel,
	onRecordsChanged,
	onBackgroundError,
}: Omit<
	CreateBrowserWorkspaceRuntimeOptions,
	'persistenceKey' | 'transport'
> & {
	account: BrowserWorkspaceAccount;
}) {
	const runtime = createBrowserRuntimeWithPersistence({
		persistenceKey: accountBrowserPersistenceKey(account),
		transport: account.transport,
		createBroadcastChannel,
		onRecordsChanged,
		onBackgroundError,
	});
	return Object.freeze({
		open: runtime.open,
		async add(definition: WorkspaceLens, copy: LogicalWorkspaceCopy) {
			await runtime.open(definition);
			await runtime.whenReady(definition.id);
			return runtime.addToAccount(definition.id, copy);
		},
		async export(definition: WorkspaceLens): Promise<LogicalWorkspaceExport> {
			await runtime.open(definition);
			return runtime.exportAccount(definition.id);
		},
		[Symbol.asyncDispose]: runtime[Symbol.asyncDispose],
	});
}

/** Create the page-side client for one OPFS-owning records Worker. */
function createBrowserRuntimeWithPersistence({
	persistenceKey,
	transport: transportInput,
	createBroadcastChannel = defaultBroadcastChannel,
	onRecordsChanged = () => undefined,
	onBackgroundError = () => undefined,
}: CreateBrowserWorkspaceRuntimeOptions) {
	if (persistenceKey.length === 0) {
		throw new Error('Workspace persistence key must not be empty');
	}
	const persistenceHash = sha256Hex(persistenceKey);
	const transport = normalizeTransport(transportInput);
	const pending = new Map<number, PendingRequest>();
	const workspaces = new Map<string, BoundWorkspace>();
	const invalidationChannel = createBroadcastChannel(
		`epicenter-${persistenceHash}-records`,
	);
	let requestId = 0;
	let isDisposed = false;
	let worker: Worker | undefined;
	let workerFailure: Error | undefined;
	let ready: ReturnType<typeof Promise.withResolvers<void>> | undefined;

	function assertOpen(): void {
		if (isDisposed) throw new Error('Browser workspace runtime is disposed');
	}

	function emitRecordsChanged(workspaceId: string, broadcast: boolean): void {
		if (broadcast) {
			invalidationChannel?.postMessage({
				type: 'records-changed',
				workspaceId,
			} satisfies InvalidationMessage);
		}
		onRecordsChanged(workspaceId);
	}

	if (invalidationChannel) {
		invalidationChannel.onmessage = (event: MessageEvent<unknown>) => {
			if (!isInvalidationMessage(event.data)) return;
			const message = event.data;
			if (!workspaces.has(message.workspaceId)) return;
			emitRecordsChanged(message.workspaceId, false);
		};
	}

	function recordsWorker(): {
		worker: Worker;
		ready: ReturnType<typeof Promise.withResolvers<void>>;
	} {
		assertOpen();
		if (workerFailure) throw workerFailure;
		if (worker && ready) return { worker, ready };
		ready = Promise.withResolvers<void>();
		worker = new Worker(
			new URL('./browser-runtime-worker.ts', import.meta.url),
			{ type: 'module', name: `epicenter-${persistenceHash}` },
		);
		const ownedWorker = worker;
		const ownedReady = ready;
		ownedWorker.addEventListener(
			'message',
			(event: MessageEvent<BrowserRuntimeMessage>) => {
				const message = event.data;
				switch (message.type) {
					case 'ready':
						ownedReady.resolve();
						return;
					case 'records-changed':
						emitRecordsChanged(message.workspaceId, true);
						return;
					case 'rows-deleted':
						workspaces
							.get(message.workspaceId)
							?.notifyRowsDeleted(message.addresses);
						return;
					case 'sync-status':
						workspaces
							.get(message.workspaceId)
							?.notifySyncStatus(message.status);
						return;
					case 'background-error': {
						const cause = new Error(message.message);
						cause.name = message.name;
						onBackgroundError(cause, message.workspaceId);
						return;
					}
					case 'transport-request':
						void proxyRecordTransport(ownedWorker, message);
						return;
					case 'result':
						pending.get(message.id)?.resolve(message.value);
						pending.delete(message.id);
						return;
					case 'error': {
						const cause = new Error(message.message);
						cause.name = message.name;
						pending.get(message.id)?.reject(cause);
						pending.delete(message.id);
						return;
					}
					default:
						message satisfies never;
				}
			},
		);
		ownedWorker.addEventListener('error', (event) => {
			const cause = new Error(
				event.message || 'Browser workspace Worker failed',
			);
			workerFailure = cause;
			ownedReady.reject(cause);
			for (const request of pending.values()) request.reject(cause);
			pending.clear();
		});
		return { worker: ownedWorker, ready: ownedReady };
	}

	async function proxyRecordTransport(
		ownedWorker: Worker,
		message: Extract<BrowserRuntimeMessage, { type: 'transport-request' }>,
	): Promise<void> {
		try {
			if (!transport) {
				throw new Error('Browser workspace transport is not bound');
			}
			let response: Response;
			try {
				response = await transport.fetch(
					new URL(
						`api/workspaces/${encodeURIComponent(message.workspaceId)}/records/${message.action}`,
						transport.baseUrl,
					),
					{
						method: 'POST',
						headers: {
							...transport.headers,
							'content-type': 'application/json',
						},
						credentials: transport.credentials,
						body: JSON.stringify(message.body),
					},
				);
			} catch (cause) {
				throw new CurrentStateTransportInterruption(
					'offline',
					'Record authority is unreachable',
					{ cause },
				);
			}
			const body = await response.text();
			if (!response.ok) {
				if (response.status === 401 || response.status === 403) {
					throw new CurrentStateTransportInterruption(
						'authentication',
						`Record authority rejected authentication (${response.status})`,
					);
				}
				if (
					response.status === 408 ||
					response.status === 425 ||
					response.status === 429 ||
					response.status >= 500
				) {
					throw new CurrentStateTransportInterruption(
						'retrying',
						`Record authority is temporarily unavailable (${response.status})`,
					);
				}
				throw new Error(`Record sync HTTP ${response.status}: ${body}`);
			}
			let value: unknown;
			try {
				value = body === '' ? null : JSON.parse(body);
			} catch (cause) {
				throw new Error(
					`Record sync returned non-JSON HTTP ${response.status}`,
					{ cause },
				);
			}
			if (!isDisposed) {
				ownedWorker.postMessage({
					type: 'transport-result',
					transportId: message.transportId,
					value,
				});
			}
		} catch (cause) {
			if (!isDisposed) {
				ownedWorker.postMessage({
					type: 'transport-error',
					transportId: message.transportId,
					name: cause instanceof Error ? cause.name : 'Error',
					message: cause instanceof Error ? cause.message : String(cause),
					...(cause instanceof CurrentStateTransportInterruption
						? { pendingReason: cause.reason }
						: {}),
				});
			}
		}
	}

	function request<TResult>(
		manifest: BrowserWorkspaceManifest,
		operation: BrowserRecordOperation,
	): Promise<TResult> {
		assertOpen();
		const owner = recordsWorker();
		const send = (): Promise<TResult> => {
			assertOpen();
			const id = ++requestId;
			return new Promise<TResult>((resolve, reject) => {
				pending.set(id, {
					resolve(value) {
						resolve(value as TResult);
					},
					reject,
				});
				owner.worker.postMessage({
					id,
					manifest,
					operation,
				} satisfies BrowserRuntimeRequest);
			});
		};
		// Always chain on readiness, even once resolved: `then` callbacks run
		// in registration order, so every request posts in invocation order. A
		// ready-state fast path would let a post-ready request overtake one
		// still parked on this promise from before readiness.
		return owner.ready.promise.then(send);
	}

	function createBinding(
		workspaceId: string,
		manifest: BrowserWorkspaceManifest,
	) {
		const rowsDeletedListeners = new Set<(addresses: RowAddress[]) => void>();
		const syncStatusListeners = new Set<
			(status: WorkspaceSyncStatus) => void
		>();
		let syncStatus: WorkspaceSyncStatus = { phase: 'syncing' };
		let isReady = manifest.rowSync === undefined;
		const readinessWaiters = new Set<
			ReturnType<typeof Promise.withResolvers<void>>
		>();

		function notifyReady(): void {
			if (isReady) return;
			isReady = true;
			for (const waiter of readinessWaiters) waiter.resolve();
			readinessWaiters.clear();
		}

		function markNotReady(): void {
			isReady = false;
		}

		function rejectReadiness(cause: Error): void {
			for (const waiter of readinessWaiters) waiter.reject(cause);
			readinessWaiters.clear();
		}

		function waitUntilReady(): Promise<void> {
			if (isReady) return Promise.resolve();
			if (syncStatus.phase === 'recovery-required') {
				return Promise.reject(new Error('Workspace requires lineage recovery'));
			}
			if (syncStatus.phase === 'upgrade-required') {
				return Promise.reject(
					new Error('Workspace protocol requires an upgrade'),
				);
			}
			const waiter = Promise.withResolvers<void>();
			readinessWaiters.add(waiter);
			return waiter.promise;
		}

		function notifyRowsDeleted(addresses: RowAddress[]): void {
			for (const listener of rowsDeletedListeners) listener(addresses);
		}

		function notifySyncStatus(status: WorkspaceSyncStatus): void {
			syncStatus = status;
			if (status.phase === 'caught-up') notifyReady();
			if (status.phase === 'recovery-required') {
				rejectReadiness(new Error('Workspace requires lineage recovery'));
			}
			if (status.phase === 'upgrade-required') {
				rejectReadiness(new Error('Workspace protocol requires an upgrade'));
			}
			for (const listener of syncStatusListeners) listener(status);
		}

		const documentStore = lazyBrowserDocumentStore(
			documentDatabaseName(persistenceHash, workspaceId),
		);
		async function captureDocuments(
			copy: LogicalWorkspaceCopy,
		): Promise<LogicalWorkspaceCopy> {
			await documents.captureDurabilityBarrier();
			return withCapturedDocuments(copy, documentStore.capture);
		}
		const documents = createRowDocumentRuntime<DocumentConnection>({
			store: documentStore,
			isLive: async ({ table, rowId }) =>
				(await request<Record<string, unknown> | undefined>(manifest, {
					kind: 'read-current-row',
					table,
					rowId,
				})) !== undefined,
			...(transport
				? {
						connect(address, document) {
							const connection = attachAuthenticatedDocumentConnection({
								document,
								url: rowDocumentWebSocketUrl({
									baseUrl: transport.baseUrl,
									workspaceId,
									address,
								}),
								openWebSocket: transport.openWebSocket,
							});
							return {
								connection,
								dispose: connection.dispose,
							};
						},
					}
				: {}),
		});
		rowsDeletedListeners.add((addresses) => {
			for (const address of addresses) void documents.revoke(address);
		});

		const sync: WorkspaceSync | null = manifest.rowSync
			? Object.freeze({
					get status() {
						return syncStatus;
					},
					onStatusChange(listener: (status: WorkspaceSyncStatus) => void) {
						syncStatusListeners.add(listener);
						return () => syncStatusListeners.delete(listener);
					},
					settle(): Promise<WorkspaceSyncSettlement> {
						return request<WorkspaceSyncSettlement>(manifest, {
							kind: 'sync-settle',
						});
					},
					async captureRecovery() {
						const copy = await request<LogicalWorkspaceCopy | null>(manifest, {
							kind: 'sync-capture-recovery',
						});
						// The recovery copy carries each row's locally durable compact
						// document state (ADR-0142); the Worker owns only rows and KV.
						return copy === null ? null : captureDocuments(copy);
					},
					async startFresh() {
						if (syncStatus.phase !== 'recovery-required') {
							throw new Error('Workspace does not require lineage recovery');
						}
						markNotReady();
						await request(manifest, { kind: 'sync-start-fresh' });
						notifyReady();
					},
				})
			: null;

		function createView<TDefinition extends WorkspaceLens>(
			definition: TDefinition,
		): Workspace<TDefinition> {
			const tables = Object.fromEntries(
				Object.entries(definition.tables).map(([table, tableDefinition]) => {
					const lens = compileTableLens(tableDefinition);
					return [
						table,
						Object.freeze({
							async get(id: string) {
								const fields = await request<JsonObject | undefined>(manifest, {
									kind: 'read-current-row',
									table,
									rowId: id,
								});
								return fields === undefined
									? Ok(undefined)
									: lens.project(table, id, fields);
							},
							async list() {
								const current = await request<
									{ rowId: string; fields: JsonObject }[]
								>(manifest, { kind: 'list-current-rows', table });
								const rows: Record<string, unknown>[] = [];
								const nonconforming = [];
								for (const row of current) {
									const projected = lens.project(table, row.rowId, row.fields);
									if (projected.error === null) rows.push(projected.data);
									else nonconforming.push(projected.error);
								}
								return { rows, nonconforming };
							},
							async create(input: Record<string, unknown>) {
								const fields = lens.validateCreate(input);
								const id = mintRowId();
								await admit({ kind: 'create', table, rowId: id, fields });
								const projected = lens.project(table, id, fields);
								if (projected.error !== null)
									throw new Error(projected.error.message);
								return projected.data;
							},
							async update(id: string, changes: Record<string, unknown>) {
								const normalized = lens.normalizeChanges(changes);
								const current = await request<JsonObject | undefined>(
									manifest,
									{
										kind: 'read-current-row',
										table,
										rowId: id,
									},
								);
								if (
									Object.keys(normalized.set).length === 0 &&
									normalized.unset.length === 0
								) {
									return current === undefined
										? Ok(undefined)
										: lens.project(table, id, current);
								}
								await admit({
									kind: 'update',
									table,
									rowId: id,
									fields: normalized,
								});
								const fields = await request<JsonObject | undefined>(manifest, {
									kind: 'read-current-row',
									table,
									rowId: id,
								});
								return fields === undefined
									? Ok(undefined)
									: lens.project(table, id, fields);
							},
							async delete(id: string) {
								await admit({ kind: 'delete', table, rowId: id });
								notifyRowsDeleted([{ table, rowId: id }]);
							},
							document: Object.freeze({
								open(rowId: string) {
									return documents.open({ table, rowId });
								},
							}),
						}),
					];
				}),
			) as unknown as WorkspaceTables<DefinitionTables<TDefinition>>;
			const kvLens = compileKvLens(definition.kv as KvDefinitions);
			const requireKv = (key: string) => {
				const compiled = kvLens.get(key);
				if (!compiled) throw new Error(`Unknown kv key '${key}'`);
				return compiled;
			};
			const readKvMap = () =>
				request<JsonObject>(manifest, { kind: 'kv-read-map' });
			const kv = Object.freeze({
				async get(key: string) {
					const compiled = requireKv(key);
					const map = await readKvMap();
					if (!Object.hasOwn(map, key)) return Ok(undefined);
					const raw = map[key];
					return compiled.check(raw)
						? Ok(structuredClone(raw))
						: KvReadError.NonconformingKvValue({
								key,
								raw: structuredClone(raw) as never,
							});
				},
				async set(key: string, value: unknown) {
					const compiled = requireKv(key);
					if (!compiled.check(value)) {
						return KvWriteError.InvalidKvWrite({
							key,
							reason: 'value does not satisfy the declared schema',
						});
					}
					await admit({
						kind: 'update',
						table: RESERVED_KV_TABLE,
						rowId: RESERVED_KV_ROW_ID,
						fields: {
							set: { [key]: structuredClone(value) as never },
							unset: [],
						},
					});
					return Ok(undefined);
				},
				async unset(key: string) {
					requireKv(key);
					await admit({
						kind: 'update',
						table: RESERVED_KV_TABLE,
						rowId: RESERVED_KV_ROW_ID,
						fields: { set: {}, unset: [key] },
					});
				},
			});

			return Object.freeze({
				id: definition.id,
				tables,
				kv: kv as never,
				sync,
				async sql<TResultSchema extends TSchema>(
					query: string,
					parameters: readonly SqliteValue[],
					resultSchema: TResultSchema,
				): Promise<Static<TResultSchema>[]> {
					const rows = await request<Record<string, unknown>[]>(manifest, {
						kind: 'sql',
						query,
						parameters,
					});
					for (const [index, row] of rows.entries()) {
						if (!Value.Check(resultSchema, row)) {
							const issues = [...Value.Errors(resultSchema, row)]
								.map((issue) => `${issue.instancePath}: ${issue.message}`)
								.join('; ');
							throw new TypeError(
								`SQL row ${index} does not satisfy the result schema: ${issues}`,
							);
						}
					}
					return rows as Static<TResultSchema>[];
				},
			}) as Workspace<TDefinition>;
		}

		function admit(intent: WireRowIntent): Promise<void> {
			return request(manifest, { kind: 'admit-intent', intent });
		}

		return {
			createView,
			sync,
			notifyRowsDeleted,
			notifySyncStatus,
			notifyReady,
			waitUntilReady,
			rejectReadiness,
			revokeDocuments(cause: Error) {
				return documents.revokeAll(cause);
			},
			captureDurability: documents.captureDurabilityBarrier,
			disposeDocuments: documents[Symbol.asyncDispose],
			deleteDocuments: documentStore.deleteAll,
			captureDocuments,
			async importDocuments(copy: LogicalWorkspaceCopy) {
				for (const row of copy.rows) {
					if (row.document === undefined) continue;
					await documents.importUpdate(
						{ table: row.table, rowId: row.rowId },
						row.document,
					);
				}
			},
		};
	}

	return {
		/**
		 * Opens the workspace and resolves only with a ready handle. The stable
		 * Worker proxy and its FIFO request queue exist behind this promise;
		 * no half-open handle ever escapes. A failed acquisition (for example
		 * the named held-storage error) rejects and is terminal for this
		 * runtime: the Worker keeps the failure, every later `open` returns the
		 * same rejection, and recovery is an explicit reload.
		 */
		open<TDefinition extends WorkspaceLens>(
			definition: TDefinition,
		): Promise<Workspace<TDefinition>> {
			assertOpen();
			const bound = workspaces.get(definition.id);
			if (bound) {
				const cached = bound.views.get(definition);
				if (cached) return cached as Promise<Workspace<TDefinition>>;
				const existing = bound;
				const view = existing.opened.then(() =>
					existing.createView(definition),
				);
				bound.views.set(definition, view as Promise<Workspace<WorkspaceLens>>);
				return view;
			}
			const manifest: BrowserWorkspaceManifest = {
				workspaceId: definition.id,
				storageKey: workspaceStorageKey(persistenceKey, definition.id),
				rowSync: transport?.binding,
			};
			const binding = createBinding(definition.id, manifest);
			const createdBound: BoundWorkspace = {
				manifest,
				views: new Map(),
				...binding,
				opened: undefined as never,
			};
			workspaces.set(definition.id, createdBound);
			createdBound.opened = request<{ isReady: boolean }>(manifest, {
				kind: 'open',
			}).then(
				({ isReady }) => {
					if (isReady) createdBound.notifyReady();
				},
				(cause) => {
					const error =
						cause instanceof Error ? cause : new Error(String(cause));
					void createdBound.revokeDocuments(error);
					createdBound.rejectReadiness(error);
					throw error;
				},
			);
			const view = createdBound.opened.then(() =>
				createdBound.createView(definition),
			);
			createdBound.views.set(
				definition,
				view as Promise<Workspace<WorkspaceLens>>,
			);
			return view;
		},
		async captureLocal(workspaceId: string): Promise<LogicalWorkspaceCopy> {
			const bound = workspaces.get(workspaceId);
			if (!bound) {
				return Promise.reject(
					new Error(`Device workspace '${workspaceId}' is not open`),
				);
			}
			const copy = await request<LogicalWorkspaceCopy>(bound.manifest, {
				kind: 'logical-capture',
			});
			return bound.captureDocuments(copy);
		},
		async exportAccount(workspaceId: string): Promise<LogicalWorkspaceExport> {
			const bound = workspaces.get(workspaceId);
			if (!bound) {
				return Promise.reject(
					new Error(`Account workspace '${workspaceId}' is not open`),
				);
			}
			const sync = bound.sync;
			if (!sync) {
				return Promise.reject(
					new Error(`Workspace '${workspaceId}' has no synchronization`),
				);
			}
			// Best effort: a pending settlement (offline, storage-limit) never
			// blocks export; the outcome reports the quality of the scalar cut.
			const settlement = await sync.settle();
			const copy = await request<LogicalWorkspaceCopy>(bound.manifest, {
				kind: 'capture-visible',
			});
			return { settlement, ...(await bound.captureDocuments(copy)) };
		},
		captureDurability(workspaceId: string): Promise<void> {
			const bound = workspaces.get(workspaceId);
			if (!bound) {
				return Promise.reject(
					new Error(`Workspace '${workspaceId}' is not open`),
				);
			}
			return bound.captureDurability();
		},
		whenReady(workspaceId: string): Promise<void> {
			const bound = workspaces.get(workspaceId);
			if (!bound) {
				return Promise.reject(
					new Error(`Workspace '${workspaceId}' is not open`),
				);
			}
			return bound.waitUntilReady();
		},
		async deleteLocal(workspaceId: string): Promise<void> {
			const bound = workspaces.get(workspaceId);
			if (!bound)
				throw new Error(`Device workspace '${workspaceId}' is not open`);
			await request<void>(bound.manifest, { kind: 'logical-delete' });
			await bound.revokeDocuments(
				new Error('Device workspace data was deleted'),
			);
			await bound.deleteDocuments();
		},
		async addToAccount(
			workspaceId: string,
			copy: LogicalWorkspaceCopy,
		): Promise<void> {
			const bound = workspaces.get(workspaceId);
			if (!bound) {
				return Promise.reject(
					new Error(`Account workspace '${workspaceId}' is not open`),
				);
			}
			await request(bound.manifest, { kind: 'logical-add', copy });
			await bound.importDocuments(copy);
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			worker?.terminate();
			const cause = new Error('Browser workspace runtime is disposed');
			// Revoke page-side row documents so retained handles fail loudly
			// instead of queueing persistence at a terminated Worker.
			for (const bound of workspaces.values()) {
				await bound.disposeDocuments();
				bound.rejectReadiness(cause);
			}
			ready?.reject(cause);
			for (const request of pending.values()) request.reject(cause);
			pending.clear();
			workspaces.clear();
			invalidationChannel?.close();
		},
	};
}

export type BrowserWorkspaceRuntime = ReturnType<
	typeof createDeviceBrowserWorkspaceRuntime
>;

function isInvalidationMessage(value: unknown): value is InvalidationMessage {
	if (typeof value !== 'object' || value === null || !('type' in value)) {
		return false;
	}
	const message = value as Record<string, unknown>;
	if (typeof message.workspaceId !== 'string') return false;
	return message.type === 'records-changed';
}

function defaultBroadcastChannel(
	name: string,
): RuntimeBroadcastChannel | undefined {
	return typeof BroadcastChannel === 'undefined'
		? undefined
		: new BroadcastChannel(name);
}

function normalizeTransport(
	input: CreateBrowserWorkspaceRuntimeOptions['transport'],
):
	| {
			binding: BrowserRowSyncBinding;
			baseUrl: string;
			fetch: BrowserRecordFetch;
			openWebSocket: BrowserWorkspaceTransport['openWebSocket'];
			headers: Record<string, string>;
			credentials: RequestCredentials;
	  }
	| undefined {
	if (!input) return undefined;
	const baseUrl = ensureTrailingSlash(new URL(input.baseUrl).href);
	const headers = Object.fromEntries(
		Object.entries(input.headers ?? {}).map(([name, value]) => {
			if (name.length === 0 || value.length === 0) {
				throw new Error('Record sync headers must not be empty');
			}
			return [name, value];
		}),
	);
	return {
		binding: { intervalMs: input.pollIntervalMs ?? 30_000 },
		baseUrl,
		fetch: input.fetch ?? globalThis.fetch.bind(globalThis),
		openWebSocket: input.openWebSocket,
		headers,
		credentials: input.credentials ?? 'same-origin',
	};
}

function documentDatabaseName(
	persistenceHash: string,
	workspaceId: string,
): string {
	return `epicenter-${persistenceHash}-${sha256Hex(workspaceId)}-documents-v1`;
}

function lazyBrowserDocumentStore(databaseName: string): DocumentStore {
	let store: DocumentStore | undefined;
	const opened = () =>
		(store ??= createBrowserIndexedDbDocumentStore({ databaseName }));
	return {
		attach: (address, document) => opened().attach(address, document),
		capture: (address) => opened().capture(address),
		delete: (address) => opened().delete(address),
		deleteAll: () => opened().deleteAll(),
	};
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith('/') ? value : `${value}/`;
}

function workspaceStorageKey(
	persistenceKey: string,
	workspaceId: string,
): string {
	return sha256Hex(JSON.stringify([persistenceKey, workspaceId]));
}
