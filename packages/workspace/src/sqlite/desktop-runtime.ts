import type { SqliteValue } from '@epicenter/record-sync';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { openCollaboration } from '../document/open-collaboration.js';
import { roomWsUrl } from '../document/transport.js';
import { sha256Hex } from '../shared/sha256.js';
import { createIndexedDbDocumentLocalStore } from './browser-document-store.js';
import {
	type DesktopRecordOperation,
	type DesktopWorkspaceResponse,
	decodeDesktopRecordResult,
	desktopDocumentOpenUrl,
	desktopWorkspaceRecordUrl,
} from './desktop-protocol.js';
import {
	createDocumentNamespace,
	createDocumentRoomCatalog,
	type DocumentRoomManifest,
} from './document-runtime.js';
import type { OpenedWorkspace, WorkspaceTables } from './runtime.js';
import type { WorkspaceDefinition } from './runtime-definition.js';

type DefinitionTables<TDefinition> =
	TDefinition extends WorkspaceDefinition<infer TTables> ? TTables : never;

export type CreateDesktopWorkspaceRuntimeOptions = {
	baseUrl?: string;
	fetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	openWebSocket?: Parameters<typeof openCollaboration>[1]['openWebSocket'];
	indexedDB?: IDBFactory;
	onRecordsChanged?(workspaceId: string): void;
};

/** Same-origin WebView client for one Bun-owned static workspace catalog. */
export function createDesktopWorkspaceRuntime({
	baseUrl = location.origin,
	fetch: fetchInput = globalThis.fetch,
	openWebSocket,
	indexedDB = globalThis.indexedDB,
	onRecordsChanged = () => undefined,
}: CreateDesktopWorkspaceRuntimeOptions = {}) {
	const origin = new URL(baseUrl).origin;
	const openSocket =
		openWebSocket ??
		((url: string | URL, protocols?: string[]) =>
			new WebSocket(url, protocols));
	const localStore = createIndexedDbDocumentLocalStore(
		`epicenter-desktop-${sha256Hex(origin)}-documents`,
		indexedDB,
	);
	const rooms = createDocumentRoomCatalog({
		localStore,
		attachSync(ydoc, storageRef) {
			const config = {
				url: roomWsUrl({
					baseURL: origin,
					guid: storageRef,
					nodeId: crypto.randomUUID() as never,
				}),
				onReconnectSignal: () => () => undefined,
			};
			return openCollaboration(ydoc, { ...config, openWebSocket: openSocket });
		},
	});
	const workspaces = new Map<
		string,
		{ definition: WorkspaceDefinition; handle: object }
	>();
	let disposed = false;

	const request = async <TResult>(
		workspaceId: string,
		operation: DesktopRecordOperation,
	): Promise<TResult> => {
		assertOpen();
		const response = await fetchInput(
			desktopWorkspaceRecordUrl(origin, workspaceId),
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify(operation),
			},
		);
		const envelope = (await response.json()) as DesktopWorkspaceResponse;
		if (!response.ok || envelope.error !== null) {
			throw new Error(
				envelope.error?.message ?? `Desktop workspace HTTP ${response.status}`,
			);
		}
		if (
			operation.kind === 'create' ||
			operation.kind === 'patch' ||
			operation.kind === 'delete'
		) {
			onRecordsChanged(workspaceId);
		}
		return decodeDesktopRecordResult(operation, envelope.data) as TResult;
	};

	function assertOpen(): void {
		if (disposed) throw new Error('Desktop workspace runtime is disposed');
	}

	function createHandle<TDefinition extends WorkspaceDefinition>(
		definition: TDefinition,
	): OpenedWorkspace<TDefinition> {
		const tables = Object.fromEntries(
			Object.entries(definition.tables).map(([table, tableDefinition]) => {
				const bodyStub = tableDefinition.body
					? {
							body: Object.freeze({
								async open(): Promise<never> {
									throw new Error(
										'Row bodies are not yet openable in the desktop runtime',
									);
								},
							}),
						}
					: {};
				const handle = {
					...bodyStub,
					get(id: string) {
						return request(definition.id, { kind: 'get', table, id });
					},
					scan(options: { cursor?: string; limit: number }) {
						return request(definition.id, { kind: 'scan', table, options });
					},
					create(input: Record<string, unknown>) {
						return request(definition.id, { kind: 'create', table, input });
					},
					patch(id: string, patch: Record<string, unknown>) {
						const set: Record<string, unknown> = {};
						const unset: string[] = [];
						for (const [name, value] of Object.entries(patch)) {
							if (value === undefined) unset.push(name);
							else set[name] = value;
						}
						return request(definition.id, {
							kind: 'patch',
							table,
							id,
							set,
							unset,
						});
					},
					delete(id: string) {
						return request<void>(definition.id, {
							kind: 'delete',
							table,
							id,
						});
					},
				};
				return [table, Object.freeze(handle)];
			}),
		) as unknown as WorkspaceTables<DefinitionTables<TDefinition>>;

		const kv = Object.freeze({
			async get(): Promise<never> {
				throw new Error('kv is not yet wired through the desktop runtime');
			},
			async set(): Promise<never> {
				throw new Error('kv is not yet wired through the desktop runtime');
			},
			async unset(): Promise<never> {
				throw new Error('kv is not yet wired through the desktop runtime');
			},
			observe(): never {
				throw new Error('kv is not yet wired through the desktop runtime');
			},
		});

		return Object.freeze({
			id: definition.id,
			tables,
			kv: kv as never,
			documents: createDocumentNamespace({
				workspaceId: definition.id,
				definitions: definition.documents,
				roomCatalog: rooms,
				assertRuntimeOpen: assertOpen,
				async resolveManifest({ workspaceId, declaration, params }) {
					const response = await fetchInput(
						desktopDocumentOpenUrl(origin, workspaceId, declaration),
						{
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							credentials: 'same-origin',
							body: JSON.stringify({ params }),
						},
					);
					const envelope = (await response.json()) as DesktopWorkspaceResponse;
					if (!response.ok || envelope.error !== null) {
						throw new Error(
							envelope.error?.message ??
								`Desktop document HTTP ${response.status}`,
						);
					}
					return envelope.data as DocumentRoomManifest;
				},
			}),
			records: Object.freeze({
				async sql<TResultSchema extends TSchema>(
					query: string,
					parameters: readonly SqliteValue[],
					resultSchema: TResultSchema,
				): Promise<Static<TResultSchema>[]> {
					const rows = await request<unknown[]>(definition.id, {
						kind: 'sql',
						query,
						parameters,
					});
					for (const [index, row] of rows.entries()) {
						if (!Value.Check(resultSchema, row)) {
							throw new TypeError(
								`Desktop SQL row ${index} does not satisfy the result schema`,
							);
						}
					}
					return rows as Static<TResultSchema>[];
				},
			}),
		}) as unknown as OpenedWorkspace<TDefinition>;
	}

	return Object.freeze({
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
			const handle = createHandle(definition);
			workspaces.set(definition.id, { definition, handle });
			return handle;
		},
		async [Symbol.asyncDispose]() {
			if (disposed) return;
			disposed = true;
			workspaces.clear();
			await rooms[Symbol.asyncDispose]();
			await localStore[Symbol.asyncDispose]();
		},
	});
}

export type DesktopWorkspaceRuntime = ReturnType<
	typeof createDesktopWorkspaceRuntime
>;
