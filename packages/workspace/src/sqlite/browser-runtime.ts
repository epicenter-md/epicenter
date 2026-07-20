import { sha256Hex } from '@epicenter/row-sync';
import {
	attachAuthenticatedDocumentConnection,
	type DocumentConnection,
	rowDocumentWebSocketUrl,
} from '../document-provider/connection/index.js';
import { createDocumentStore } from '../document-provider/persistence.js';
import { createRowDocumentRuntime } from '../document-provider/runtime/index.js';

import {
	accountBrowserPersistenceKey,
	deviceBrowserPersistenceKey,
	type WorkspaceAccount,
} from './account-runtime.js';
import {
	type BrowserRecordOperation,
	type BrowserRowSyncBinding,
	type BrowserRuntimeMessage,
	type BrowserRuntimeRequest,
	type BrowserWorkspaceManifest,
	isWorkspaceStorageMovedError,
} from './browser-runtime-protocol.js';
import type {
	LogicalWorkspaceCopy,
	LogicalWorkspaceExport,
} from './canonical-addition.js';
import type {
	WorkspaceSync,
	WorkspaceSyncSettlement,
	WorkspaceSyncStatus,
} from './canonical-sync-supervisor.js';
import { CurrentStateTransportInterruption } from './current-state-transport.js';
import type { Workspace } from './runtime.js';
import { assertWorkspaceId, type WorkspaceLens } from './workspace-lens.js';
import { createWorkspaceView } from './workspace-view.js';

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
};

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
		async capture(workspaceId: string) {
			await runtime.openRaw(workspaceId);
			await runtime.captureDurability(workspaceId);
			return runtime.captureLocal(workspaceId);
		},
		/** A Device export is the local capture; there is no authority to settle. */
		async export(workspaceId: string): Promise<LogicalWorkspaceExport> {
			await runtime.openRaw(workspaceId);
			await runtime.captureDurability(workspaceId);
			return {
				settlement: null,
				...(await runtime.captureLocal(workspaceId)),
			};
		},
		async delete(workspaceId: string) {
			await runtime.openRaw(workspaceId);
			return runtime.deleteLocal(workspaceId);
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
		async add(workspaceId: string, copy: LogicalWorkspaceCopy) {
			await runtime.openRaw(workspaceId);
			await runtime.whenReady(workspaceId);
			return runtime.addToAccount(workspaceId, copy);
		},
		async export(workspaceId: string): Promise<LogicalWorkspaceExport> {
			await runtime.openRaw(workspaceId);
			return runtime.exportAccount(workspaceId);
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
	const transportControllers = new Map<number, AbortController>();
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
						if (isWorkspaceStorageMovedError(cause)) {
							for (const controller of transportControllers.values()) {
								controller.abort(cause);
							}
							transportControllers.clear();
						}
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
		const controller = new AbortController();
		transportControllers.set(message.transportId, controller);
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
						signal: controller.signal,
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
		} finally {
			transportControllers.delete(message.transportId);
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

		const documents = createRowDocumentRuntime<DocumentConnection>({
			// The Worker owns the durable update log inside the same OPFS SQLite
			// store as scalar state; the page carries only load and append across
			// the message boundary, so a storage steal rejects document work the
			// same way it rejects scalar work.
			store: createDocumentStore({
				load: (address) =>
					request<readonly Uint8Array[]>(manifest, {
						kind: 'document-load',
						table: address.table,
						rowId: address.rowId,
					}),
				async append(address, update) {
					await request<void>(manifest, {
						kind: 'document-append',
						table: address.table,
						rowId: address.rowId,
						update,
					});
				},
			}),
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
						// The Worker folds each row's locally durable compact document
						// state into the copy (ADR-0142); the page only waits for its
						// admitted appends to commit before the capture reads the log.
						await documents.captureDurabilityBarrier();
						return request<LogicalWorkspaceCopy | null>(manifest, {
							kind: 'sync-capture-recovery',
						});
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
			return createWorkspaceView(definition, {
				read(table, rowId) {
					return request(manifest, {
						kind: 'read-current-row',
						table,
						rowId,
					});
				},
				list(table) {
					return request(manifest, { kind: 'list-current-rows', table });
				},
				readKvMap() {
					return request(manifest, { kind: 'kv-read-map' });
				},
				admit(intent) {
					return request(manifest, { kind: 'admit-intent', intent });
				},
				sql(query, parameters) {
					return request(manifest, { kind: 'sql', query, parameters });
				},
				openDocument(table, rowId) {
					return documents.open({ table, rowId });
				},
				sync,
				afterDelete(address) {
					notifyRowsDeleted([address]);
				},
			});
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
		};
	}

	function openRaw(workspaceId: string): Promise<BoundWorkspace> {
		assertOpen();
		assertWorkspaceId(workspaceId);
		const existing = workspaces.get(workspaceId);
		if (existing) return existing.opened.then(() => existing);
		const manifest: BrowserWorkspaceManifest = {
			workspaceId,
			storageKey: workspaceStorageKey(persistenceKey, workspaceId),
			rowSync: transport?.binding,
		};
		const binding = createBinding(workspaceId, manifest);
		const created: BoundWorkspace = {
			manifest,
			views: new Map(),
			...binding,
			opened: undefined as never,
		};
		workspaces.set(workspaceId, created);
		created.opened = request<{ isReady: boolean }>(manifest, {
			kind: 'open',
		}).then(
			({ isReady }) => {
				if (isReady) created.notifyReady();
			},
			(cause) => {
				const error = cause instanceof Error ? cause : new Error(String(cause));
				void created.revokeDocuments(error);
				created.rejectReadiness(error);
				throw error;
			},
		);
		return created.opened.then(() => created);
	}

	return {
		openRaw,
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
			const existing = workspaces.get(definition.id);
			if (existing) {
				const cached = existing.views.get(definition);
				if (cached) return cached as Promise<Workspace<TDefinition>>;
				const view = existing.opened.then(() =>
					existing.createView(definition),
				);
				existing.views.set(
					definition,
					view as Promise<Workspace<WorkspaceLens>>,
				);
				return view;
			}
			const opening = openRaw(definition.id);
			const created = workspaces.get(definition.id);
			if (!created)
				throw new Error(`Workspace '${definition.id}' failed to open`);
			const view = opening.then(() => created.createView(definition));
			created.views.set(definition, view as Promise<Workspace<WorkspaceLens>>);
			return view;
		},
		async captureLocal(workspaceId: string): Promise<LogicalWorkspaceCopy> {
			const bound = workspaces.get(workspaceId);
			if (!bound) {
				return Promise.reject(
					new Error(`Device workspace '${workspaceId}' is not open`),
				);
			}
			// The Worker folds durable document state into the copy.
			return request<LogicalWorkspaceCopy>(bound.manifest, {
				kind: 'logical-capture',
			});
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
			await bound.captureDurability();
			const copy = await request<LogicalWorkspaceCopy>(bound.manifest, {
				kind: 'capture-visible',
			});
			return { settlement, ...copy };
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
			// Revoke live handles first so already-captured edits drain into the
			// Worker's log; logical-delete then removes rows and document logs in
			// one owner-side transaction.
			await bound.revokeDocuments(
				new Error('Device workspace data was deleted'),
			);
			await request<void>(bound.manifest, { kind: 'logical-delete' });
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
			// The Worker admits the scalar rows and appends each copied document
			// snapshot into its own log inside this one logical-add; the page
			// never re-ships document bytes it already sent in the copy.
			await request(bound.manifest, { kind: 'logical-add', copy });
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			const cause = new Error('Browser workspace runtime is disposed');
			for (const controller of transportControllers.values()) {
				controller.abort(cause);
			}
			transportControllers.clear();
			// Drain admitted document appends while their Worker is still alive.
			// Terminating it first strands the persistence tail waiting for results
			// that only the terminated Worker could deliver.
			const failures: unknown[] = [];
			for (const bound of workspaces.values()) {
				try {
					await bound.disposeDocuments();
				} catch (failure) {
					failures.push(failure);
				}
				bound.rejectReadiness(cause);
			}
			ready?.reject(cause);
			for (const request of pending.values()) request.reject(cause);
			pending.clear();
			worker?.terminate();
			workspaces.clear();
			invalidationChannel?.close();
			if (failures.length > 0) {
				throw new AggregateError(
					failures,
					'Browser row-document disposal failed',
				);
			}
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

function ensureTrailingSlash(value: string): string {
	return value.endsWith('/') ? value : `${value}/`;
}

function workspaceStorageKey(
	persistenceKey: string,
	workspaceId: string,
): string {
	return sha256Hex(JSON.stringify([persistenceKey, workspaceId]));
}
