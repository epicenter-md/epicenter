import {
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
	type WireRowIntent,
} from '@epicenter/row-sync';
import type { SqliteValue } from '@epicenter/sqlite';
import { customAlphabet } from 'nanoid';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { Ok } from 'wellcrafted/result';
import { isWorkspaceRowAbsentError } from './canonical-store.js';
import type { WorkspaceSync } from './canonical-sync-supervisor.js';
import {
	compileKvLens,
	type KvDefinitions,
	KvReadError,
	KvWriteError,
} from './kv-definition.js';
import {
	compileTableLens,
	type JsonObject,
	RowLensError,
} from './lens-definition.js';
import type { Workspace, WorkspaceTables } from './runtime.js';
import type { WorkspaceLens } from './workspace-lens.js';

type LensTables<TLens> =
	TLens extends WorkspaceLens<infer TTables> ? TTables : never;

type AsyncWorkspaceClient = {
	read(table: string, rowId: string): Promise<JsonObject | undefined>;
	list(table: string): Promise<{ rowId: string; fields: JsonObject }[]>;
	readKvMap(): Promise<JsonObject>;
	admit(intent: WireRowIntent): Promise<void>;
	sql(query: string, parameters: readonly SqliteValue[]): Promise<unknown[]>;
	openDocument(table: string, rowId: string): Promise<unknown>;
	readonly sync: WorkspaceSync | null;
	afterDelete?(address: { table: string; rowId: string }): void;
};

const mintRowId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);

/** Compose one caller-owned lens over an asynchronous schema-opaque transport. */
export function createAsyncWorkspaceView<TLens extends WorkspaceLens>(
	lensDefinition: TLens,
	client: AsyncWorkspaceClient,
): Workspace<TLens> {
	const tables = Object.fromEntries(
		Object.entries(lensDefinition.tables).map(([table, tableDefinition]) => {
			const lens = compileTableLens(tableDefinition);
			return [
				table,
				Object.freeze({
					async get(id: string) {
						const fields = await client.read(table, id);
						return fields === undefined
							? Ok(undefined)
							: lens.project(table, id, fields);
					},
					async list() {
						const rows: Record<string, unknown>[] = [];
						const nonconforming = [];
						for (const row of await client.list(table)) {
							const projected = lens.project(table, row.rowId, row.fields);
							if (projected.error === null) rows.push(projected.data);
							else nonconforming.push(projected.error);
						}
						return { rows, nonconforming };
					},
					async create(input: Record<string, unknown>) {
						const fields = lens.validateCreate(input);
						const id = mintRowId();
						await client.admit({ kind: 'create', table, rowId: id, fields });
						const projected = lens.project(table, id, fields);
						if (projected.error !== null)
							throw new Error(projected.error.message);
						return projected.data;
					},
					async update(id: string, changes: Record<string, unknown>) {
						const fields = lens.normalizeChanges(changes);
						const before = await client.read(table, id);
						if (before === undefined) {
							return RowLensError.MissingRow({ table, id });
						}
						if (
							Object.keys(fields.set).length === 0 &&
							fields.unset.length === 0
						) {
							return lens.project(table, id, before);
						}
						try {
							await client.admit({ kind: 'update', table, rowId: id, fields });
						} catch (cause) {
							// The row can die between the read above and admission; the
							// owner guard refuses it there, surfaced as the same result.
							if (isWorkspaceRowAbsentError(cause)) {
								return RowLensError.MissingRow({ table, id });
							}
							throw cause;
						}
						const current = await client.read(table, id);
						return current === undefined
							? RowLensError.MissingRow({ table, id })
							: lens.project(table, id, current);
					},
					async delete(id: string) {
						// No renderer-side pre-check: the owner guard atomically refuses
						// a delete of an absent row with the named error, so a row that
						// dies after any earlier read still fails instead of silently
						// succeeding. afterDelete runs only once the delete commits.
						await client.admit({ kind: 'delete', table, rowId: id });
						client.afterDelete?.({ table, rowId: id });
					},
					document: Object.freeze({
						open(rowId: string) {
							return client.openDocument(table, rowId);
						},
					}),
				}),
			];
		}),
	) as unknown as WorkspaceTables<LensTables<TLens>>;

	const kvLens = compileKvLens(lensDefinition.kv as KvDefinitions);
	function requireKv(key: string) {
		const compiled = kvLens.get(key);
		if (!compiled) throw new Error(`Unknown kv key '${key}'`);
		return compiled;
	}
	async function readKvMap(): Promise<JsonObject> {
		return client.readKvMap();
	}
	const kv = Object.freeze({
		async get(key: string) {
			const compiled = requireKv(key);
			const map = await readKvMap();
			if (!Object.hasOwn(map, key)) return Ok(undefined);
			const raw = map[key];
			return compiled.check(raw)
				? Ok(structuredClone(raw))
				: KvReadError.NonconformingKvValue({
						key,
						raw: structuredClone(raw) as never,
					});
		},
		async set(key: string, value: unknown) {
			const compiled = requireKv(key);
			if (!compiled.check(value)) {
				return KvWriteError.InvalidKvWrite({
					key,
					reason: 'value does not satisfy the declared schema',
				});
			}
			await client.admit({
				kind: 'update',
				table: RESERVED_KV_TABLE,
				rowId: RESERVED_KV_ROW_ID,
				fields: {
					set: { [key]: structuredClone(value) as never },
					unset: [],
				},
			});
			return Ok(undefined);
		},
		async unset(key: string) {
			requireKv(key);
			await client.admit({
				kind: 'update',
				table: RESERVED_KV_TABLE,
				rowId: RESERVED_KV_ROW_ID,
				fields: { set: {}, unset: [key] },
			});
		},
	});

	return Object.freeze({
		id: lensDefinition.id,
		tables,
		kv: kv as never,
		sync: client.sync,
		async sql<TResultSchema extends TSchema>(
			query: string,
			parameters: readonly SqliteValue[],
			resultSchema: TResultSchema,
		): Promise<Static<TResultSchema>[]> {
			const rows = await client.sql(query, parameters);
			for (const [index, row] of rows.entries()) {
				if (!Value.Check(resultSchema, row)) {
					const issues = [...Value.Errors(resultSchema, row)]
						.map((issue) => `${issue.instancePath}: ${issue.message}`)
						.join('; ');
					throw new TypeError(
						`SQL row ${index} does not satisfy the result schema: ${issues}`,
					);
				}
			}
			return rows as Static<TResultSchema>[];
		},
	}) as Workspace<TLens>;
}
