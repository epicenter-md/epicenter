import type { SqliteValue } from '@epicenter/row-sync';
import type { Static, TSchema } from 'typebox';
import { sha256Hex } from '../shared/sha256.js';
import {
	type BrowserRecordOperation,
	type BrowserRecordSyncBinding,
	type BrowserRuntimeMessage,
	type BrowserRuntimeRequest,
	type BrowserWorkspaceManifest,
	serializeTableLenses,
} from './browser-runtime-protocol.js';
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

export type CreateBrowserWorkspaceRuntimeOptions = {
	authorityKey: string;
	recordSync?: {
		baseUrl: string;
		fetch?: BrowserRecordFetch;
		headers?: Readonly<Record<string, string>>;
		credentials?: RequestCredentials;
	};
	createBroadcastChannel?(name: string): RuntimeBroadcastChannel | undefined;
	onRecordsChanged?(workspaceId: string): void;
	onBackgroundError?(cause: Error, workspaceId: string): void;
};

/** Create the page-side client for one OPFS-owning records Worker. */
export function createBrowserWorkspaceRuntime({
	authorityKey,
	recordSync: recordSyncInput,
	createBroadcastChannel = defaultBroadcastChannel,
	onRecordsChanged = () => undefined,
	onBackgroundError = () => undefined,
}: CreateBrowserWorkspaceRuntimeOptions) {
	if (authorityKey.length === 0) {
		throw new Error('Authority key must not be empty');
	}
	const authorityStorageKey = sha256Hex(authorityKey);
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
			{ type: 'module', name: `epicenter-${authorityStorageKey}` },
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
	): OpenedWorkspace<TDefinition> {
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
					delete(id: string) {
						return request<void>(manifest, { kind: 'delete', table, id });
					},
					document: Object.freeze({
						async open(): Promise<never> {
							throw new Error(
								'Row documents are not yet openable in the browser runtime',
							);
						},
					}),
				}),
			]),
		) as unknown as WorkspaceTables<DefinitionTables<TDefinition>>;

		const kv = Object.freeze({
			get(key: string) {
				return request(manifest, { kind: 'kv-get', key });
			},
			set(key: string, value: unknown) {
				return request(manifest, { kind: 'kv-set', key, value });
			},
			async unset(key: string) {
				await request(manifest, { kind: 'kv-unset', key });
			},
			observe(): never {
				throw new Error(
					'kv.observe is not yet wired through the browser Worker runtime',
				);
			},
		});

		return Object.freeze({
			id: definition.id,
			tables,
			kv: kv as never,
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
		}) as unknown as OpenedWorkspace<TDefinition>;
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
				storageKey: sha256Hex(`${authorityKey}\0${definition.id}`),
				tables: serializeTableLenses(definition.tables),
				kv: JSON.parse(JSON.stringify(definition.kv)),
				recordSync: recordSync?.binding,
			};
			const handle = createHandle(definition, manifest);
			workspaces.set(definition.id, {
				definition,
				manifest,
				handle,
			});
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
		},
	};
}

export type BrowserWorkspaceRuntime = ReturnType<
	typeof createBrowserWorkspaceRuntime
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
		binding: { intervalMs: 30_000 },
		baseUrl,
		fetch: input.fetch ?? globalThis.fetch.bind(globalThis),
		headers,
		credentials: input.credentials ?? 'same-origin',
	};
}
