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

export type CreateDesktopWorkspaceRuntimeOptions = {
	baseUrl?: string;
	fetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	onRecordsChanged?(workspaceId: string): void;
};

/** Same-origin WebView client for one Bun-owned static workspace catalog. */
export function createDesktopWorkspaceRuntime({
	baseUrl = location.origin,
	fetch: fetchInput = globalThis.fetch,
	onRecordsChanged = () => undefined,
}: CreateDesktopWorkspaceRuntimeOptions = {}) {
	const origin = new URL(baseUrl).origin;
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
		const kvObservers = new Map<string, Set<() => void>>();
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
		const notifyKv = (key: string): void => {
			for (const handler of kvObservers.get(key) ?? []) handler();
		};
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
			async set(key: string, value: unknown) {
				const before = await request<{
					data?: unknown;
					error: unknown;
				}>(definition.id, { kind: 'kv-get', key });
				const result = await request<{ data?: unknown; error: unknown }>(
					definition.id,
					{ kind: 'kv-set', key, value },
				);
				if (
					result.error === null &&
					(before.error !== null ||
						JSON.stringify(before.data) !== JSON.stringify(value))
				) {
					notifyKv(key);
				}
				return result;
			},
			async unset(key: string) {
				const before = await request<{
					data?: unknown;
					error: unknown;
				}>(definition.id, { kind: 'kv-get', key });
				await request<void>(definition.id, { kind: 'kv-unset', key });
				if (before.error !== null || before.data !== undefined) notifyKv(key);
			},
			observe(key: string, handler: () => void) {
				let handlers = kvObservers.get(key);
				if (!handlers) {
					handlers = new Set();
					kvObservers.set(key, handlers);
				}
				handlers.add(handler);
				return () => {
					handlers.delete(handler);
					if (handlers.size === 0) kvObservers.delete(key);
				};
			},
		});

		return Object.freeze({
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
		},
	});
}

export type DesktopWorkspaceRuntime = ReturnType<
	typeof createDesktopWorkspaceRuntime
>;
