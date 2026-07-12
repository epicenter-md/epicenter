import type { Static } from 'typebox';
import type {
	KvDefinitions,
	RowFor,
	TableDefinitions,
	WorkspaceDefinition,
} from './definition.js';

export type TableListOptions = {
	where?: Record<string, unknown>;
	orderBy?: string;
	desc?: boolean;
	limit?: number;
};

export type WorkspaceMutation =
	| { kind: 'put'; table: string; row: Record<string, unknown> }
	| {
			kind: 'patch';
			table: string;
			rowId: string;
			cells: Record<string, unknown>;
	  }
	| { kind: 'remove'; table: string; rowId: string }
	| { kind: 'setKv'; key: string; value: unknown }
	| { kind: 'clearKv'; key: string };

export type WorkspaceServiceRequest =
	| { kind: 'describe' }
	| { kind: 'get'; table: string; rowId: string }
	| { kind: 'list'; table: string; options?: TableListOptions }
	| { kind: 'has'; table: string; rowId: string }
	| { kind: 'count'; table: string }
	| { kind: 'getKv'; key: string }
	| { kind: 'mutate'; mutations: readonly WorkspaceMutation[] };

export type WorkspaceServiceResponse =
	| {
			kind: 'workspace';
			workspaceKind: 'local' | 'replica';
			workspaceId: string;
			schemaIdentity: string;
	  }
	| { kind: 'row'; row: Record<string, unknown> | null }
	| { kind: 'rows'; rows: Record<string, unknown>[] }
	| { kind: 'boolean'; value: boolean }
	| { kind: 'count'; value: number }
	| { kind: 'value'; value: unknown }
	| { kind: 'mutation'; results: readonly unknown[] };

/** Runtime brand that lets transitional reactive adapters avoid probe reads. */
export const asyncWorkspaceHandle = Symbol('epicenter.asyncWorkspaceHandle');

export type TableCommitDelta<
	TRow extends { id: string } = { id: string } & Record<string, unknown>,
> = {
	upserted: readonly TRow[];
	removed: readonly string[];
};

/** One committed database change, projected to values the UI can cache. */
export type WorkspaceCommitDelta = {
	tables: Readonly<Record<string, TableCommitDelta>>;
	kv: Readonly<Record<string, unknown>>;
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
		mutations: readonly WorkspaceMutation[],
	): Promise<readonly unknown[]> {
		if (mutations.length === 0) return [];
		const response = await port.request({ kind: 'mutate', mutations });
		return expectResponse(response, 'mutation').results;
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
					return expectResponse(response, 'row').row as { id: string } | null;
				},
				async list(options) {
					const response = await port.request({
						kind: 'list',
						table: tableName,
						options: options as TableListOptions | undefined,
					});
					return expectResponse(response, 'rows').rows as { id: string }[];
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
							callback(tableDelta as TableCommitDelta<{ id: string }>);
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
			return expectResponse(response, 'value').value as Static<
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
