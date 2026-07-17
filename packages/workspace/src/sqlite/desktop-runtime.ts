import { decodeBase64, type SqliteValue } from '@epicenter/row-sync';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { createDocumentRuntime } from './canonical-documents.js';
import {
	type DesktopRecordOperation,
	type DesktopWorkspaceResponse,
	decodeDesktopRecordResult,
	desktopWorkspaceUrl,
} from './desktop-protocol.js';
import type { OpenedWorkspace, WorkspaceTables } from './runtime.js';
import type { WorkspaceDefinition } from './runtime-definition.js';

type DefinitionTables<TDefinition> =
	TDefinition extends WorkspaceDefinition<infer TTables> ? TTables : never;

type RowAddress = { table: string; rowId: string };

type DesktopInvalidationMessage =
	| { type: 'records-changed'; workspaceId: string }
	| { type: 'rows-deleted'; workspaceId: string; addresses: RowAddress[] };

type DesktopRuntimeBroadcastChannel = {
	onmessage: ((event: MessageEvent<unknown>) => void) | null;
	postMessage(message: unknown): void;
	close(): void;
};

type BoundWorkspace = {
	definition: WorkspaceDefinition;
	handle: OpenedWorkspace<WorkspaceDefinition>;
	revokeRows(addresses: RowAddress[]): void;
	revokeDocuments(cause: Error): void;
};

export type CreateDesktopWorkspaceRuntimeOptions = {
	baseUrl?: string;
	fetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	createBroadcastChannel?(
		name: string,
	): DesktopRuntimeBroadcastChannel | undefined;
	onRecordsChanged?(workspaceId: string): void;
};

/** Same-origin WebView client for one Bun-owned static workspace catalog. */
export function createDesktopWorkspaceRuntime({
	baseUrl = location.origin,
	fetch: fetchInput = globalThis.fetch,
	createBroadcastChannel = defaultBroadcastChannel,
	onRecordsChanged = () => undefined,
}: CreateDesktopWorkspaceRuntimeOptions = {}) {
	const origin = new URL(baseUrl).origin;
	const workspaces = new Map<string, BoundWorkspace>();
	const invalidationChannel = createBroadcastChannel(
		'epicenter-desktop-workspaces',
	);
	let disposed = false;

	function emitRecordsChanged(workspaceId: string, broadcast: boolean): void {
		if (broadcast) {
			invalidationChannel?.postMessage({
				type: 'records-changed',
				workspaceId,
			} satisfies DesktopInvalidationMessage);
		}
		onRecordsChanged(workspaceId);
	}

	if (invalidationChannel) {
		invalidationChannel.onmessage = (event: MessageEvent<unknown>) => {
			const message = parseInvalidationMessage(event.data);
			if (!message || !workspaces.has(message.workspaceId)) return;
			switch (message.type) {
				case 'records-changed':
					emitRecordsChanged(message.workspaceId, false);
					return;
				case 'rows-deleted':
					workspaces.get(message.workspaceId)?.revokeRows(message.addresses);
					return;
			}
		};
	}

	const request = async <TResult>(
		workspaceId: string,
		operation: DesktopRecordOperation,
	): Promise<TResult> => {
		assertOpen();
		const response = await fetchInput(
			desktopWorkspaceUrl(origin, workspaceId),
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
			operation.kind === 'update' ||
			operation.kind === 'delete' ||
			operation.kind === 'kv-set' ||
			operation.kind === 'kv-unset' ||
			operation.kind === 'admit-document-intent'
		) {
			emitRecordsChanged(workspaceId, true);
		}
		return decodeDesktopRecordResult(operation, envelope.data) as TResult;
	};

	function assertOpen(): void {
		if (disposed) throw new Error('Desktop workspace runtime is disposed');
	}

	function createHandle<TDefinition extends WorkspaceDefinition>(
		definition: TDefinition,
	): {
		handle: OpenedWorkspace<TDefinition>;
		revokeRows(addresses: RowAddress[]): void;
		revokeDocuments(cause: Error): void;
	} {
		const documents = createDocumentRuntime({
			admitIntent(intent) {
				return request(definition.id, {
					kind: 'admit-document-intent',
					intent,
				});
			},
			readCurrentRow(table, rowId) {
				return request(definition.id, {
					kind: 'read-current-row',
					table,
					rowId,
				});
			},
			async readParts(table, rowId) {
				const state = await request<string>(definition.id, {
					kind: 'read-current-document',
					table,
					rowId,
				});
				return [decodeBase64(state)];
			},
		});
		const tables = Object.fromEntries(
			Object.keys(definition.tables).map((table) => [
				table,
				Object.freeze({
					get(id: string) {
						return request(definition.id, { kind: 'get', table, id });
					},
					list() {
						return request(definition.id, { kind: 'list', table });
					},
					create(input: Record<string, unknown>) {
						return request(definition.id, {
							kind: 'create',
							table,
							input,
						});
					},
					update(id: string, changes: Record<string, unknown>) {
						const set: Record<string, unknown> = {};
						const unset: string[] = [];
						for (const [name, value] of Object.entries(changes)) {
							if (value === undefined) unset.push(name);
							else set[name] = value;
						}
						return request(definition.id, {
							kind: 'update',
							table,
							id,
							set,
							unset,
						});
					},
					async delete(id: string) {
						await request<void>(definition.id, {
							kind: 'delete',
							table,
							id,
						});
						documents.revoke([{ table, rowId: id }]);
						invalidationChannel?.postMessage({
							type: 'rows-deleted',
							workspaceId: definition.id,
							addresses: [{ table, rowId: id }],
						} satisfies DesktopInvalidationMessage);
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
				return request(definition.id, { kind: 'kv-get', key });
			},
			set(key: string, value: unknown) {
				return request(definition.id, { kind: 'kv-set', key, value });
			},
			async unset(key: string) {
				await request<void>(definition.id, { kind: 'kv-unset', key });
			},
		});

		const handle = Object.freeze({
			id: definition.id,
			tables,
			kv: kv as never,
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
		}) as unknown as OpenedWorkspace<TDefinition>;
		return {
			handle,
			revokeRows: documents.revoke,
			revokeDocuments: documents.revokeAll,
		};
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
			const binding = createHandle(definition);
			workspaces.set(definition.id, {
				definition,
				...binding,
			});
			return binding.handle;
		},
		async [Symbol.asyncDispose]() {
			if (disposed) return;
			disposed = true;
			const cause = new Error('Desktop workspace runtime is disposed');
			for (const bound of workspaces.values()) bound.revokeDocuments(cause);
			workspaces.clear();
			invalidationChannel?.close();
		},
	});
}

export type DesktopWorkspaceRuntime = ReturnType<
	typeof createDesktopWorkspaceRuntime
>;

function parseInvalidationMessage(
	value: unknown,
): DesktopInvalidationMessage | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const message = value as Record<string, unknown>;
	if (typeof message.workspaceId !== 'string') return undefined;
	if (message.type === 'records-changed') {
		return {
			type: message.type,
			workspaceId: message.workspaceId,
		};
	}
	if (
		message.type !== 'rows-deleted' ||
		!Array.isArray(message.addresses) ||
		!message.addresses.every(isRowAddress)
	) {
		return undefined;
	}
	return {
		type: 'rows-deleted',
		workspaceId: message.workspaceId,
		addresses: message.addresses,
	};
}

function isRowAddress(value: unknown): value is RowAddress {
	return (
		typeof value === 'object' &&
		value !== null &&
		'table' in value &&
		typeof value.table === 'string' &&
		'rowId' in value &&
		typeof value.rowId === 'string'
	);
}

function defaultBroadcastChannel(
	name: string,
): DesktopRuntimeBroadcastChannel | undefined {
	return typeof BroadcastChannel === 'undefined'
		? undefined
		: new BroadcastChannel(name);
}
