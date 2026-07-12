import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import type {
	KvDefinitions,
	RowFor,
	TableDefinitions,
	WorkspaceDefinition,
} from './definition.js';
import type {
	TableListOptions,
	WorkspaceCommitDelta,
	WorkspaceMutation,
	WorkspaceServiceRequest,
	WorkspaceServiceResponse,
} from './service-protocol.js';

export type {
	TableListOptions,
	WorkspaceCommitDelta,
	WorkspaceMutation,
	WorkspaceServiceRequest,
	WorkspaceServiceResponse,
} from './service-protocol.js';

/** Runtime brand that lets transitional reactive adapters avoid probe reads. */
export const asyncWorkspaceHandle = Symbol('epicenter.asyncWorkspaceHandle');

export type TableCommitDelta<
	TRow extends { id: string } = { id: string } & Record<string, unknown>,
> = {
	upserted: readonly TRow[];
	removed: readonly string[];
};

/** Async boundary implemented by a browser worker, Bun service, or test port. */
export type WorkspaceServicePort = {
	request(request: WorkspaceServiceRequest): Promise<WorkspaceServiceResponse>;
	/** Register locally before returning; never round-trip to subscribe. */
	observe(callback: (delta: WorkspaceCommitDelta) => void): () => void;
};

export type AsyncTable<TRow extends { id: string }> = {
	readonly [asyncWorkspaceHandle]: 'table';
	get(id: TRow['id']): Promise<TRow | null>;
	list(options?: {
		where?: Partial<TRow>;
		orderBy?: keyof TRow & string;
		desc?: boolean;
		limit?: number;
	}): Promise<TRow[]>;
	has(id: TRow['id']): Promise<boolean>;
	count(): Promise<number>;
	put(row: TRow): Promise<void>;
	patch(id: TRow['id'], cells: Partial<Omit<TRow, 'id'>>): Promise<TRow | null>;
	remove(id: TRow['id']): Promise<void>;
	observe(callback: (delta: TableCommitDelta<TRow>) => void): () => void;
};

export type AsyncTables<TTables extends TableDefinitions> = {
	[K in keyof TTables]: AsyncTable<RowFor<TTables[K]>>;
};

export type AsyncKv<TKv extends KvDefinitions> = {
	readonly [asyncWorkspaceHandle]: 'kv';
	get<TKey extends keyof TKv & string>(
		key: TKey,
	): Promise<Static<TKv[TKey]['schema']>>;
	set<TKey extends keyof TKv & string>(
		key: TKey,
		value: Static<TKv[TKey]['schema']>,
	): Promise<void>;
	clear(key: keyof TKv & string): Promise<void>;
	observe(
		callback: (
			values: Readonly<Partial<{ [K in keyof TKv]: Static<TKv[K]['schema']> }>>,
		) => void,
	): () => void;
};

type BatchTable<TRow extends { id: string }> = {
	put(row: TRow): void;
	patch(id: TRow['id'], cells: Partial<Omit<TRow, 'id'>>): void;
	remove(id: TRow['id']): void;
};

export type WorkspaceWriteBatch<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = {
	tables: { [K in keyof TTables]: BatchTable<RowFor<TTables[K]>> };
	kv: {
		set<TKey extends keyof TKv & string>(
			key: TKey,
			value: Static<TKv[TKey]['schema']>,
		): void;
		clear(key: keyof TKv & string): void;
	};
};

export type AsyncWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = {
	tables: AsyncTables<TTables>;
	kv: AsyncKv<TKv>;
	/** Build one serializable, write-only atomic mutation. */
	transact(
		build: (batch: WorkspaceWriteBatch<TTables, TKv>) => void,
	): Promise<void>;
};

export function createWorkspaceClient<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	port: WorkspaceServicePort,
): AsyncWorkspace<TTables, TKv> {
	function rowForTable(
		tableName: string,
		value: unknown,
		expectedId?: string,
	): { id: string } & Record<string, unknown> {
		const table = definition.tables[tableName];
		if (!table || !Value.Check(table.schema, value)) {
			throw new Error(
				`Workspace service returned an invalid '${tableName}' row`,
			);
		}
		const row = value as { id: string } & Record<string, unknown>;
		if (expectedId !== undefined && row.id !== expectedId) {
			throw new Error(
				`Workspace service returned row '${row.id}' for '${tableName}.${expectedId}'`,
			);
		}
		return row;
	}

	function kvValue(key: string, value: unknown): unknown {
		const kv = definition.kv[key];
		if (!kv?.compiledValue.check(value)) {
			throw new Error(
				`Workspace service returned an invalid KV value for '${key}'`,
			);
		}
		return value;
	}

	function expectResponse<TKind extends WorkspaceServiceResponse['kind']>(
		response: WorkspaceServiceResponse,
		kind: TKind,
	): Extract<WorkspaceServiceResponse, { kind: TKind }> {
		if (response.kind !== kind) {
			throw new Error(
				`Workspace service returned '${response.kind}' for a '${kind}' request`,
			);
		}
		return response as Extract<WorkspaceServiceResponse, { kind: TKind }>;
	}

	async function sendMutations(
		mutations: WorkspaceMutation[],
	): Promise<readonly unknown[]> {
		if (mutations.length === 0) return [];
		const response = await port.request({ kind: 'mutate', mutations });
		const results = expectResponse(response, 'mutation').results;
		if (results.length !== mutations.length) {
			throw new Error(
				'Workspace service returned the wrong mutation result count',
			);
		}
		for (const [index, mutation] of mutations.entries()) {
			const result = results[index];
			if (mutation.kind === 'patch') {
				if (result !== null) {
					rowForTable(mutation.table, result, mutation.rowId);
				}
			} else if (result !== null) {
				throw new Error(
					`Workspace service returned a value for '${mutation.kind}'`,
				);
			}
		}
		return results;
	}

	const tables = Object.fromEntries(
		Object.keys(definition.tables).map((tableName) => {
			const table: AsyncTable<{ id: string }> = {
				[asyncWorkspaceHandle]: 'table',
				async get(rowId) {
					const response = await port.request({
						kind: 'get',
						table: tableName,
						rowId,
					});
					const row = expectResponse(response, 'row').row;
					return row === null ? null : rowForTable(tableName, row, rowId);
				},
				async list(options) {
					const response = await port.request({
						kind: 'list',
						table: tableName,
						options: options as TableListOptions | undefined,
					});
					return expectResponse(response, 'rows').rows.map((row) =>
						rowForTable(tableName, row),
					);
				},
				async has(rowId) {
					const response = await port.request({
						kind: 'has',
						table: tableName,
						rowId,
					});
					return expectResponse(response, 'boolean').value;
				},
				async count() {
					const response = await port.request({
						kind: 'count',
						table: tableName,
					});
					return expectResponse(response, 'count').value;
				},
				async put(row) {
					await sendMutations([
						{
							kind: 'put',
							table: tableName,
							row: row as Record<string, unknown>,
						},
					]);
				},
				async patch(rowId, cells) {
					const results = await sendMutations([
						{
							kind: 'patch',
							table: tableName,
							rowId,
							cells,
						},
					]);
					return (results[0] ?? null) as { id: string } | null;
				},
				async remove(rowId) {
					await sendMutations([{ kind: 'remove', table: tableName, rowId }]);
				},
				observe(callback) {
					return port.observe((delta) => {
						const tableDelta = delta.tables[tableName];
						if (tableDelta) {
							callback({
								upserted: tableDelta.upserted.map((row) =>
									rowForTable(tableName, row),
								),
								removed: tableDelta.removed,
							} satisfies TableCommitDelta<{ id: string }>);
						}
					});
				},
			};
			return [tableName, table];
		}),
	) as AsyncTables<TTables>;

	const kv: AsyncKv<TKv> = {
		[asyncWorkspaceHandle]: 'kv',
		async get(key) {
			const response = await port.request({ kind: 'getKv', key });
			return kvValue(key, expectResponse(response, 'value').value) as Static<
				TKv[typeof key]['schema']
			>;
		},
		async set(key, value) {
			await sendMutations([{ kind: 'setKv', key, value }]);
		},
		async clear(key) {
			await sendMutations([{ kind: 'clearKv', key }]);
		},
		observe(callback) {
			return port.observe((delta) => {
				if (Object.keys(delta.kv).length > 0) {
					for (const [key, value] of Object.entries(delta.kv)) {
						kvValue(key, value);
					}
					callback(
						delta.kv as Partial<{
							[K in keyof TKv]: Static<TKv[K]['schema']>;
						}>,
					);
				}
			});
		},
	};

	return {
		tables,
		kv,
		async transact(build) {
			const mutations: WorkspaceMutation[] = [];
			const batchTables = Object.fromEntries(
				Object.keys(definition.tables).map((tableName) => [
					tableName,
					{
						put(row: Record<string, unknown>) {
							mutations.push({ kind: 'put', table: tableName, row });
						},
						patch(rowId: string, cells: Record<string, unknown>) {
							mutations.push({ kind: 'patch', table: tableName, rowId, cells });
						},
						remove(rowId: string) {
							mutations.push({ kind: 'remove', table: tableName, rowId });
						},
					},
				]),
			) as WorkspaceWriteBatch<TTables, TKv>['tables'];
			const result: unknown = build({
				tables: batchTables,
				kv: {
					set(key, value) {
						mutations.push({ kind: 'setKv', key, value });
					},
					clear(key) {
						mutations.push({ kind: 'clearKv', key });
					},
				},
			});
			if (
				result &&
				typeof (result as PromiseLike<unknown>).then === 'function'
			) {
				void Promise.resolve(result).catch(() => undefined);
				throw new Error('Workspace transaction builders must be synchronous');
			}
			await sendMutations(mutations);
		},
	};
}
