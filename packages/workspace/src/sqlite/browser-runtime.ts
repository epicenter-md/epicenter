import type { SqliteValue } from '@epicenter/record-sync';
import type { Static, TSchema } from 'typebox';
import * as Y from 'yjs';
import { sha256Hex } from '../shared/sha256.js';
import { createIndexedDbDocumentLocalStore } from './browser-document-store.js';
import {
	type BrowserRecordOperation,
	type BrowserRecordSyncBinding,
	type BrowserRuntimeMessage,
	type BrowserRuntimeRequest,
	type BrowserWorkspaceManifest,
	serializeTableLenses,
} from './browser-runtime-protocol.js';
import {
	type AttachDocumentSync,
	createDocumentNamespace,
	createDocumentRoomCatalog,
} from './document-runtime.js';
import type { OpenedWorkspace, WorkspaceTables } from './runtime.js';
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
};

type BrowserRecordFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

type RuntimeBroadcastChannel = {
	onmessage: ((event: MessageEvent<unknown>) => void) | null;
	postMessage(message: unknown): void;
	close(): void;
};

export type CreateBrowserWorkspaceRuntimeOptions = {
	authorityKey: string;
	/** Optional private HTTP authority binding used only inside the Worker. */
	recordSync?: {
		baseUrl: string;
		/** Auth-owned fetch. When supplied, transport is proxied from the Worker. */
		fetch?: BrowserRecordFetch;
		headers?: Readonly<Record<string, string>>;
		credentials?: RequestCredentials;
	};
	/** Environment-owned remote Yjs attachment, started after IndexedDB replay. */
	attachDocumentSync?: AttachDocumentSync;
	/** @internal Platform seam used by deterministic non-browser tests. */
	createBroadcastChannel?(name: string): RuntimeBroadcastChannel | undefined;
	/** Lossy re-read hint after local commits and installed remote state. */
	onRecordsChanged?(workspaceId: string): void;
	/** Environment-owned reporting for retryable background sync failures. */
	onBackgroundError?(cause: Error, workspaceId: string): void;
};

/**
 * Create a Browser runtime backed by one page-owned Dedicated Worker.
 * Workspace OPFS connections and IndexedDB document rooms remain lazy.
 */
export function createBrowserWorkspaceRuntime({
	authorityKey,
	recordSync: recordSyncInput,
	attachDocumentSync,
	createBroadcastChannel = defaultBroadcastChannel,
	onRecordsChanged = () => undefined,
	onBackgroundError = () => undefined,
}: CreateBrowserWorkspaceRuntimeOptions) {
	if (authorityKey.length === 0)
		throw new Error('Authority key must not be empty');
	const authorityStorageKey = sha256Hex(authorityKey);
	const localStore = createIndexedDbDocumentLocalStore(
		`epicenter-${authorityStorageKey}-documents`,
		globalThis.indexedDB,
	);
	const documentRoomCatalog = createDocumentRoomCatalog({
		localStore,
		attachSync: createBrowserDocumentSync(
			attachDocumentSync,
			createBroadcastChannel,
		),
	});
	const recordSync = normalizeRecordSync(recordSyncInput);
	const pending = new Map<number, PendingRequest>();
	const workspaces = new Map<string, BoundWorkspace>();
	const invalidationChannel = createBroadcastChannel(
		`epicenter-${authorityStorageKey}-records`,
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
		if (broadcast) invalidationChannel?.postMessage(workspaceId);
		onRecordsChanged(workspaceId);
	}

	if (invalidationChannel) {
		invalidationChannel.onmessage = (event: MessageEvent<unknown>) => {
			if (typeof event.data === 'string' && workspaces.has(event.data)) {
				emitRecordsChanged(event.data, false);
			}
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
			{
				type: 'module',
				name: `epicenter-${authorityStorageKey}`,
			},
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
			if (!recordSync) throw new Error('Browser record transport is not bound');
			const response = await recordSync.fetch(
				new URL(
					`/api/records/${encodeURIComponent(message.workspaceId)}/${message.action}`,
					recordSync.baseUrl,
				),
				{
					method: 'POST',
					headers: {
						...recordSync.headers,
						'content-type': 'application/json',
					},
					credentials: recordSync.credentials,
					body: JSON.stringify(message.body),
				},
			);
			const text = await response.text();
			let value: unknown;
			try {
				value = text === '' ? null : JSON.parse(text);
			} catch (cause) {
				throw new Error(
					`Record sync returned non-JSON HTTP ${response.status}`,
					{ cause },
				);
			}
			if (!response.ok) {
				throw new Error(`Record sync HTTP ${response.status}: ${text}`);
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
	): OpenedWorkspace<TDefinition> {
		const tables = Object.fromEntries(
			Object.keys(definition.tables).map((tableName) => [
				tableName,
				Object.freeze({
					get(id: string) {
						return request(manifest, { kind: 'get', table: tableName, id });
					},
					scan(options: { cursor?: string; limit: number }) {
						return request(manifest, {
							kind: 'scan',
							table: tableName,
							options,
						});
					},
					create(input: Record<string, unknown>) {
						return request(manifest, {
							kind: 'create',
							table: tableName,
							input,
						});
					},
					patch(id: string, patch: Record<string, unknown>) {
						return request(manifest, {
							kind: 'patch',
							table: tableName,
							id,
							patch,
						});
					},
					delete(id: string) {
						return request<void>(manifest, {
							kind: 'delete',
							table: tableName,
							id,
						});
					},
				}),
			]),
		) as WorkspaceTables<DefinitionTables<TDefinition>>;

		return Object.freeze({
			id: definition.id,
			tables,
			documents: createDocumentNamespace({
				authorityKey,
				workspaceId: definition.id,
				definitions: definition.documents,
				roomCatalog: documentRoomCatalog,
				assertRuntimeOpen: assertOpen,
			}),
			records: Object.freeze({
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
			}),
		}) as OpenedWorkspace<TDefinition>;
	}

	return {
		/** Bind an imported definition without opening OPFS or a document room. */
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
				storageKey: sha256Hex(`${authorityKey}\0${definition.id}`),
				tables: serializeTableLenses(definition.tables),
				recordSync: recordSync?.binding,
			};
			const handle = createHandle(definition, manifest);
			workspaces.set(definition.id, { definition, manifest, handle });
			return handle;
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			worker?.terminate();
			const cause = new Error('Browser workspace runtime is disposed');
			ready?.reject(cause);
			for (const request of pending.values()) request.reject(cause);
			pending.clear();
			workspaces.clear();
			invalidationChannel?.close();
			await documentRoomCatalog[Symbol.asyncDispose]();
			await localStore[Symbol.asyncDispose]();
		},
	};
}

export type BrowserWorkspaceRuntime = ReturnType<
	typeof createBrowserWorkspaceRuntime
>;

function createBrowserDocumentSync(
	attachRemote: AttachDocumentSync | undefined,
	createBroadcastChannel: (name: string) => RuntimeBroadcastChannel | undefined,
): AttachDocumentSync {
	return (ydoc, storageRef) => {
		const channel = createBroadcastChannel(`epicenter-${storageRef}-updates`);
		const channelOrigin = Symbol('browser-document-channel');
		const broadcast = (update: Uint8Array, origin: unknown) => {
			if (origin !== channelOrigin) channel?.postMessage(update);
		};
		if (channel) {
			channel.onmessage = (event: MessageEvent<unknown>) => {
				if (event.data instanceof ArrayBuffer) {
					Y.applyUpdate(ydoc, new Uint8Array(event.data), channelOrigin);
				} else if (event.data instanceof Uint8Array) {
					Y.applyUpdate(ydoc, event.data, channelOrigin);
				}
			};
		}
		ydoc.on('update', broadcast);
		try {
			const remote = attachRemote?.(ydoc, storageRef);
			return {
				[Symbol.dispose]() {
					ydoc.off('update', broadcast);
					channel?.close();
					remote?.[Symbol.dispose]();
				},
			};
		} catch (cause) {
			ydoc.off('update', broadcast);
			channel?.close();
			throw cause;
		}
	};
}

function defaultBroadcastChannel(
	name: string,
): RuntimeBroadcastChannel | undefined {
	return typeof BroadcastChannel === 'undefined'
		? undefined
		: new BroadcastChannel(name);
}

function normalizeRecordSync(
	input: CreateBrowserWorkspaceRuntimeOptions['recordSync'],
):
	| {
			binding: BrowserRecordSyncBinding;
			baseUrl: string;
			fetch: BrowserRecordFetch;
			headers: Record<string, string>;
			credentials: RequestCredentials;
	  }
	| undefined {
	if (!input) return undefined;
	const baseUrl = new URL(input.baseUrl).origin;
	const headers = Object.fromEntries(
		Object.entries(input.headers ?? {}).map(([name, value]) => {
			if (name.length === 0 || value.length === 0) {
				throw new Error('Record sync headers must not be empty');
			}
			return [name, value];
		}),
	);
	return {
		binding: {
			intervalMs: 30_000,
		},
		baseUrl,
		fetch: input.fetch ?? globalThis.fetch.bind(globalThis),
		headers,
		credentials: input.credentials ?? 'same-origin',
	};
}
