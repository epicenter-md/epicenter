import { Value } from 'typebox/value';
import { docGuid } from '../document/doc-guid.js';
import type { Guid } from '../shared/id.js';
import type {
	DocLayout,
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

/**
 * Guid-only handle for one declared child document field. Derived purely from
 * the workspace definition, so it never needs a service round-trip. The guid
 * grammar is the canonical 4-part dotted form owned by `docGuid`.
 */
export type AsyncTableDoc = {
	guid(rowId: string): Guid;
};

export type AsyncTableDocs<TDocs extends Readonly<Record<string, DocLayout>>> =
	{
		readonly [K in keyof TDocs]: AsyncTableDoc;
	};

export type AsyncTable<
	TRow extends { id: string },
	TDocs extends Readonly<Record<string, DocLayout>> = Readonly<
		Record<string, DocLayout>
	>,
> = {
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
	/** Child-doc identity per declared doc layout: `docs.<field>.guid(rowId)`. */
	readonly docs: AsyncTableDocs<TDocs>;
};

export type AsyncTables<TTables extends TableDefinitions> = {
	[K in keyof TTables]: AsyncTable<
		RowFor<TTables[K]>,
		TTables[K]['options']['docs']
	>;
};

type BatchTable<TRow extends { id: string }> = {
	put(row: TRow): void;
	patch(id: TRow['id'], cells: Partial<Omit<TRow, 'id'>>): void;
	remove(id: TRow['id']): void;
};

export type WorkspaceWriteBatch<TTables extends TableDefinitions> = {
	tables: { [K in keyof TTables]: BatchTable<RowFor<TTables[K]>> };
};

export type AsyncWorkspace<TTables extends TableDefinitions> = {
	tables: AsyncTables<TTables>;
	/** Build one serializable, write-only atomic mutation. */
	transact(build: (batch: WorkspaceWriteBatch<TTables>) => void): Promise<void>;
};

export function createWorkspaceClient<TTables extends TableDefinitions>(
	definition: WorkspaceDefinition<TTables>,
	port: WorkspaceServicePort,
): AsyncWorkspace<TTables> {
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
		Object.entries(definition.tables).map(([tableName, tableDefinition]) => {
			// Child-doc identity is derived from the definition alone. The guid
			// grammar stays owned by `docGuid`; this only fills in the workspace,
			// collection, and field segments the definition already fixes.
			const docs = Object.fromEntries(
				Object.keys(tableDefinition.options.docs).map((field) => [
					field,
					{
						guid: (rowId: string): Guid =>
							docGuid({
								workspaceId: definition.id,
								collection: tableName,
								rowId,
								field,
							}),
					} satisfies AsyncTableDoc,
				]),
			);
			const table: AsyncTable<{ id: string }> = {
				[asyncWorkspaceHandle]: 'table',
				docs,
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

	return {
		tables,
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
			) as WorkspaceWriteBatch<TTables>['tables'];
			const result: unknown = build({
				tables: batchTables,
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
