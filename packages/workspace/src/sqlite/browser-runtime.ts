import type { SqliteValue } from '@epicenter/row-sync';
import type { Static, TSchema } from 'typebox';
import { sha256Hex } from '../shared/sha256.js';
import {
	type BrowserRecordOperation,
	type BrowserRowSyncBinding,
	type BrowserRuntimeMessage,
	type BrowserRuntimeRequest,
	type BrowserWorkspaceManifest,
	serializeTableLenses,
} from './browser-runtime-protocol.js';
import {
	accountPersistenceKey,
	devicePersistenceKey,
	type WorkspaceAccount,
} from './account-runtime.js';
import { createDocumentRuntime } from './canonical-documents.js';
import type {
	OpenedWorkspace,
	WorkspaceOwner,
	WorkspaceTables,
} from './runtime.js';
import type { WorkspaceDefinition } from './runtime-definition.js';

type DefinitionTables<TDefinition> =
	TDefinition extends WorkspaceDefinition<infer TTables> ? TTables : never;

type PendingRequest = {
	resolve(value: unknown): void;
	reject(cause: unknown): void;
};

type BoundWorkspace = {
	definition: WorkspaceDefinition;
	manifest: BrowserWorkspaceManifest;
	handle: OpenedWorkspace<WorkspaceDefinition>;
	notifyRecordsChanged(): void;
	notifyRowsDeleted(addresses: RowAddress[]): void;
	notifyBaselinePromoted(): void;
	revokeDocuments(cause: Error): void;
};

type RowAddress = { table: string; rowId: string };

type PageWorkspaceOwner = Required<
	Pick<
		WorkspaceOwner<void | Promise<void>>,
		| 'admitIntent'
		| 'readCurrentRow'
		| 'readCurrentDocumentParts'
		| 'subscribeRowsDeleted'
		| 'subscribeBaselinePromoted'
	>
>;

type KvObservation = {
	handlers: Set<() => void>;
	lastSeen?: string;
	isInitialized: boolean;
	tail: Promise<void>;
};

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
	headers?: Readonly<Record<string, string>>;
	credentials?: RequestCredentials;
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
	return createBrowserRuntimeWithPersistence({
		persistenceKey: devicePersistenceKey(),
		createBroadcastChannel,
		onRecordsChanged,
		onBackgroundError,
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
	return createBrowserRuntimeWithPersistence({
		persistenceKey: accountPersistenceKey(account),
		transport: account.transport,
		createBroadcastChannel,
		onRecordsChanged,
		onBackgroundError,
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
		workspaces.get(workspaceId)?.notifyRecordsChanged();
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
					case 'baseline-promoted':
						workspaces.get(message.workspaceId)?.notifyBaselinePromoted();
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
			const response = await transport.fetch(
				new URL(
					`api/records/${encodeURIComponent(message.workspaceId)}/${message.action}`,
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
			const body = await response.text();
			let value: unknown;
			try {
				value = body === '' ? null : JSON.parse(body);
			} catch (cause) {
				throw new Error(
					`Record sync returned non-JSON HTTP ${response.status}`,
					{ cause },
				);
			}
			if (!response.ok) {
				throw new Error(`Record sync HTTP ${response.status}: ${body}`);
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
				});
			}
		}
	}

	async function request<TResult>(
		manifest: BrowserWorkspaceManifest,
		operation: BrowserRecordOperation,
	): Promise<TResult> {
		assertOpen();
		const owner = recordsWorker();
		await owner.ready.promise;
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
	}

	function createHandle<TDefinition extends WorkspaceDefinition>(
		definition: TDefinition,
		manifest: BrowserWorkspaceManifest,
	) {
		const rowsDeletedListeners = new Set<(addresses: RowAddress[]) => void>();
		const baselinePromotedListeners = new Set<() => void>();
		const kvObservations = new Map<string, KvObservation>();

		function getKv(key: string) {
			return request(manifest, { kind: 'kv-get', key });
		}

		function refreshKvObservation(
			key: string,
			observation: KvObservation,
		): void {
			observation.tail = observation.tail
				.then(async () => {
					if (observation.handlers.size === 0) return;
					const current = JSON.stringify(await getKv(key));
					if (!observation.isInitialized) {
						observation.lastSeen = current;
						observation.isInitialized = true;
						return;
					}
					if (observation.lastSeen === current) return;
					observation.lastSeen = current;
					for (const handler of observation.handlers) handler();
				})
				.catch((cause) => {
					onBackgroundError(
						cause instanceof Error ? cause : new Error(String(cause)),
						manifest.workspaceId,
					);
				});
		}

		function notifyRecordsChanged(): void {
			for (const [key, observation] of kvObservations) {
				refreshKvObservation(key, observation);
			}
		}

		function notifyRowsDeleted(addresses: RowAddress[]): void {
			for (const listener of rowsDeletedListeners) listener(addresses);
		}

		function notifyBaselinePromoted(): void {
			for (const listener of baselinePromotedListeners) listener();
		}

		const owner = {
			admitIntent(intent) {
				return request<void>(manifest, {
					kind: 'admit-document-intent',
					intent,
				});
			},
			readCurrentRow(table, rowId) {
				return request(manifest, { kind: 'read-current-row', table, rowId });
			},
			readCurrentDocumentParts(table, rowId) {
				return request<Uint8Array[]>(manifest, {
					kind: 'read-current-document-parts',
					table,
					rowId,
				});
			},
			subscribeRowsDeleted(listener) {
				rowsDeletedListeners.add(listener);
				return () => {
					rowsDeletedListeners.delete(listener);
				};
			},
			subscribeBaselinePromoted(listener) {
				baselinePromotedListeners.add(listener);
				return () => {
					baselinePromotedListeners.delete(listener);
				};
			},
		} satisfies PageWorkspaceOwner;
		const documents = createDocumentRuntime({
			admitIntent: owner.admitIntent,
			readParts: owner.readCurrentDocumentParts,
			readCurrentRow: owner.readCurrentRow,
		});
		owner.subscribeRowsDeleted(documents.revoke);
		owner.subscribeBaselinePromoted(documents.revokeAll);

		const tables = Object.fromEntries(
			Object.keys(definition.tables).map((table) => [
				table,
				Object.freeze({
					get(id: string) {
						return request(manifest, { kind: 'get', table, id });
					},
					list() {
						return request(manifest, { kind: 'list', table });
					},
					create(input: Record<string, unknown>) {
						return request(manifest, { kind: 'create', table, input });
					},
					update(id: string, changes: Record<string, unknown>) {
						return request(manifest, {
							kind: 'update',
							table,
							id,
							changes,
						});
					},
					async delete(id: string) {
						await request<void>(manifest, { kind: 'delete', table, id });
						notifyRowsDeleted([{ table, rowId: id }]);
					},
					document: Object.freeze({
						open(rowId: string) {
							return documents.open(table, rowId);
						},
					}),
				}),
			]),
		) as unknown as WorkspaceTables<DefinitionTables<TDefinition>>;

		const kv = Object.freeze({
			get(key: string) {
				return getKv(key);
			},
			set(key: string, value: unknown) {
				return request(manifest, { kind: 'kv-set', key, value });
			},
			async unset(key: string) {
				await request(manifest, { kind: 'kv-unset', key });
			},
			observe(key: string, handler: () => void) {
				if (!Object.hasOwn(definition.kv, key)) {
					throw new Error(`Unknown kv key '${key}'`);
				}
				let observation = kvObservations.get(key);
				if (!observation) {
					observation = {
						handlers: new Set(),
						isInitialized: false,
						tail: Promise.resolve(),
					};
					kvObservations.set(key, observation);
					refreshKvObservation(key, observation);
				}
				observation.handlers.add(handler);
				return () => {
					observation.handlers.delete(handler);
					if (observation.handlers.size === 0) kvObservations.delete(key);
				};
			},
		});

		const handle = Object.freeze({
			id: definition.id,
			tables,
			kv: kv as never,
			sql<TResultSchema extends TSchema>(
				query: string,
				parameters: readonly SqliteValue[],
				resultSchema: TResultSchema,
			): Promise<Static<TResultSchema>[]> {
				return request(manifest, {
					kind: 'sql',
					query,
					parameters,
					resultSchema,
				});
			},
		}) as unknown as OpenedWorkspace<TDefinition>;
		return {
			handle,
			notifyRecordsChanged,
			notifyRowsDeleted,
			notifyBaselinePromoted,
			revokeDocuments(cause: Error) {
				documents.revokeAll(cause);
			},
		};
	}

	return {
		async open<TDefinition extends WorkspaceDefinition>(
			definition: TDefinition,
		): Promise<OpenedWorkspace<TDefinition>> {
			assertOpen();
			const existing = workspaces.get(definition.id);
			if (existing) {
				if (existing.definition !== definition) {
					throw new Error(
						`Workspace '${definition.id}' is already bound to another definition in this runtime`,
					);
				}
				return existing.handle as OpenedWorkspace<TDefinition>;
			}
			const manifest: BrowserWorkspaceManifest = {
				workspaceId: definition.id,
				storageKey: sha256Hex(
					JSON.stringify([persistenceKey, definition.id]),
				),
				tables: serializeTableLenses(definition.tables),
				kv: JSON.parse(JSON.stringify(definition.kv)),
				rowSync: transport?.binding,
			};
			const binding = createHandle(definition, manifest);
			workspaces.set(definition.id, {
				definition,
				manifest,
				...binding,
			});
			return binding.handle;
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			worker?.terminate();
			const cause = new Error('Browser workspace runtime is disposed');
			// Revoke page-side row documents so retained handles fail loudly
			// instead of queueing persistence at a terminated Worker.
			for (const bound of workspaces.values()) bound.revokeDocuments(cause);
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
		binding: { intervalMs: 30_000 },
		baseUrl,
		fetch: input.fetch ?? globalThis.fetch.bind(globalThis),
		headers,
		credentials: input.credentials ?? 'same-origin',
	};
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith('/') ? value : `${value}/`;
}
