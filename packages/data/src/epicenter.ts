import type { SqliteDatabase, SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { customAlphabet } from 'nanoid';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';

import {
	type ConstrainedUpdate,
	type CreateInputFor,
	compileTableDefinition,
	compileValueDefinition,
	type DataReadError,
	type NonconformingRowError,
	type RowFor,
	type TableDefinition,
	type TableDefinitions,
	type ValueDefinition,
	type ValueDefinitions,
	type ValueFor,
} from './definitions.js';
import { createDocumentRuntime, type RowDocument } from './documents.js';
import {
	canonicalJson,
	type JsonObject,
	type JsonValue,
} from './protocol/index.js';
import type { Exchange, Replica, ReplicaError } from './replica/index.js';
import {
	createSyncSupervisor,
	type SyncCredentialProvider,
	type SyncSchedule,
	type SyncStatus,
} from './sync-supervisor.js';

const mintRowId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1_000;

type ReadError = DataReadError | ReplicaError;

export type ListOptions<TDefinition extends TableDefinition> = {
	where?: Partial<RowFor<TDefinition>>;
	orderBy?: {
		field: keyof RowFor<TDefinition> & string;
		direction: 'asc' | 'desc';
	};
	cursor?: string;
	limit?: number;
};

export type ListPage<TDefinition extends TableDefinition> = {
	rows: RowFor<TDefinition>[];
	nonconforming: NonconformingRowError[];
	nextCursor?: string;
};

export type TableLens<TDefinition extends TableDefinition> = {
	create(fields: CreateInputFor<TDefinition>): Promise<RowFor<TDefinition>>;
	get(id: string): Promise<Result<RowFor<TDefinition> | undefined, ReadError>>;
	update<const TChanges extends Record<string, unknown>>(
		id: string,
		patch: TChanges & ConstrainedUpdate<TDefinition, TChanges>,
	): Promise<Result<RowFor<TDefinition> | undefined, ReadError>>;
	delete(id: string): Promise<boolean>;
	list(options?: ListOptions<TDefinition>): Promise<ListPage<TDefinition>>;
	subscribe(listener: (changedIds: string[]) => void): () => void;
	openDocument(rowId: string): Promise<RowDocument>;
};

export type ValueLens<TDefinition extends ValueDefinition> = {
	get(): Promise<Result<ValueFor<TDefinition> | undefined, ReadError>>;
	set(value: ValueFor<TDefinition>): Promise<void>;
	unset(): Promise<void>;
	subscribe(listener: () => void): () => void;
};

export type BoundData<
	TTables extends TableDefinitions,
	TValues extends ValueDefinitions,
> = {
	tables: { [K in keyof TTables]: TableLens<TTables[K]> };
	values: { [K in keyof TValues]: ValueLens<TValues[K]> };
};

export type EpicenterSyncSession = {
	deploymentId: string;
	principalId: string;
	exchange: Exchange;
	credentials?: SyncCredentialProvider;
};

export type CreateEpicenterOptions = {
	replica: Replica;
	database: SqliteDatabase;
	dispose?: () => void | Promise<void>;
	log?: Logger;
	syncIntervalMs?: number;
	scheduleSync?: SyncSchedule;
};

const DataRuntimeError = defineErrors({
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: `Data subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

type ListedStateRow = SqliteRow & {
	row_id: string;
	json_payload: string;
	order_value: SqliteValue;
};

type ListCursor = {
	key: string;
	field: string;
	direction: 'asc' | 'desc';
	query: string;
	value: string | number | null;
	id: string;
};

/** Create the adapter-agnostic Data runtime over one already-open replica. */
export function createEpicenter({
	replica,
	database,
	dispose = () => undefined,
	log = createLogger('data'),
	syncIntervalMs,
	scheduleSync,
}: CreateEpicenterOptions) {
	const documents = createDocumentRuntime({ database, replica });
	const sync = createSyncSupervisor({
		replica,
		...(syncIntervalMs === undefined
			? {}
			: { exchangeIntervalMs: syncIntervalMs }),
		...(scheduleSync === undefined ? {} : { schedule: scheduleSync }),
		log,
	});
	const tableListeners = new Map<string, Set<(changedIds: string[]) => void>>();
	const valueListeners = new Map<string, Set<() => void>>();
	let isDisposed = false;

	function requireOpen(): void {
		if (isDisposed) throw new Error('Epicenter is disposed');
	}

	const stopReplicaSubscription = replica.subscribe((changes) => {
		const changedRows = new Map<string, string[]>();
		const changedValues = new Set<string>();
		for (const change of changes) {
			if (change.kind === 'value') {
				changedValues.add(change.key);
				continue;
			}
			const ids = changedRows.get(change.key) ?? [];
			if (!ids.includes(change.rowId)) ids.push(change.rowId);
			changedRows.set(change.key, ids);
			const current = replica.readRow(change.key, change.rowId);
			if (current.error === null && current.data === undefined) {
				documents.revoke({ key: change.key, rowId: change.rowId });
			}
		}
		for (const [key, ids] of changedRows) {
			for (const listener of tableListeners.get(key) ?? []) {
				try {
					listener([...ids]);
				} catch (cause) {
					log.error(DataRuntimeError.SubscriberThrew({ cause }));
				}
			}
		}
		for (const key of changedValues) {
			for (const listener of valueListeners.get(key) ?? []) {
				try {
					listener();
				} catch (cause) {
					log.error(DataRuntimeError.SubscriberThrew({ cause }));
				}
			}
		}
	});

	function bind<
		const TTables extends TableDefinitions,
		const TValues extends ValueDefinitions,
	>({
		tables,
		values,
	}: {
		tables: TTables;
		values: TValues;
	}): BoundData<TTables, TValues> {
		requireOpen();
		assertDefinitionGroup(tables, values);
		const boundTables = Object.fromEntries(
			Object.entries(tables).map(([propertyName, definition]) => [
				propertyName,
				createTableLens(definition),
			]),
		);
		const boundValues = Object.fromEntries(
			Object.entries(values).map(([propertyName, definition]) => [
				propertyName,
				createValueLens(definition),
			]),
		);
		return Object.freeze({
			tables: Object.freeze(boundTables),
			values: Object.freeze(boundValues),
		}) as BoundData<TTables, TValues>;
	}

	function createTableLens<TDefinition extends TableDefinition>(
		definition: TDefinition,
	): TableLens<TDefinition> {
		const compiled = compileTableDefinition(definition);

		const lens = {
			async create(input: Record<string, unknown>) {
				requireOpen();
				const fields = compiled.validateCreate(input);
				const id = mintRowId();
				const written = replica.write({
					kind: 'create',
					key: definition.key,
					rowId: id,
					fields,
				});
				if (written.error !== null) throw written.error;
				if (!written.data.applied) {
					throw new Error(
						`Minted row '${definition.key}.${id}' already exists`,
					);
				}
				const projected = compiled.project(id, fields);
				if (projected.error !== null) throw projected.error;
				return projected.data;
			},
			async get(id: string) {
				requireOpen();
				const stored = replica.readRow(definition.key, id);
				if (stored.error !== null) return stored;
				return stored.data === undefined
					? Ok(undefined)
					: compiled.project(id, stored.data);
			},
			async update(id: string, input: Record<string, unknown>) {
				requireOpen();
				const patch = compiled.normalizeUpdate(input);
				const before = replica.readRow(definition.key, id);
				if (before.error !== null) return before;
				if (before.data === undefined) return Ok(undefined);
				if (Object.keys(patch.set).length === 0 && patch.unset.length === 0) {
					return compiled.project(id, before.data);
				}
				const written = replica.write({
					kind: 'update',
					key: definition.key,
					rowId: id,
					fields: patch,
				});
				if (written.error !== null) return written;
				const current = replica.readRow(definition.key, id);
				if (current.error !== null) return current;
				return current.data === undefined
					? Ok(undefined)
					: compiled.project(id, current.data);
			},
			async delete(id: string) {
				requireOpen();
				const before = replica.readRow(definition.key, id);
				if (before.error !== null) throw before.error;
				if (before.data === undefined) return false;
				const written = replica.write({
					kind: 'delete',
					key: definition.key,
					rowId: id,
				});
				if (written.error !== null) throw written.error;
				return written.data.applied;
			},
			async list(options: ListOptions<TDefinition> = {}) {
				requireOpen();
				return listRows(definition, compiled, options);
			},
			subscribe(listener: (changedIds: string[]) => void) {
				requireOpen();
				const listeners = tableListeners.get(definition.key) ?? new Set();
				listeners.add(listener);
				tableListeners.set(definition.key, listeners);
				return () => {
					listeners.delete(listener);
					if (listeners.size === 0) tableListeners.delete(definition.key);
				};
			},
			openDocument(rowId: string) {
				requireOpen();
				return documents.open({ key: definition.key, rowId });
			},
		};
		return Object.freeze(lens) as TableLens<TDefinition>;
	}

	function createValueLens<TDefinition extends ValueDefinition>(
		definition: TDefinition,
	): ValueLens<TDefinition> {
		const compiled = compileValueDefinition(definition);
		return Object.freeze({
			async get() {
				requireOpen();
				const stored = replica.readValue(definition.key);
				if (stored.error !== null) return stored;
				return stored.data === undefined
					? Ok(undefined)
					: compiled.project(stored.data);
			},
			async set(value: unknown) {
				requireOpen();
				const written = replica.write({
					kind: 'set',
					key: definition.key,
					value: compiled.validate(value),
				});
				if (written.error !== null) throw written.error;
			},
			async unset() {
				requireOpen();
				const written = replica.write({
					kind: 'unset',
					key: definition.key,
				});
				if (written.error !== null) throw written.error;
			},
			subscribe(listener: () => void) {
				requireOpen();
				const listeners = valueListeners.get(definition.key) ?? new Set();
				listeners.add(listener);
				valueListeners.set(definition.key, listeners);
				return () => {
					listeners.delete(listener);
					if (listeners.size === 0) valueListeners.delete(definition.key);
				};
			},
		}) as ValueLens<TDefinition>;
	}

	async function attachSync(
		session: EpicenterSyncSession,
	): Promise<Result<void, ReplicaError>> {
		requireOpen();
		const attached = replica.attach(session);
		if (attached.error !== null) return attached;
		return sync.attach(session);
	}

	return Object.freeze({
		bind,
		attachSync,
		get syncStatus(): SyncStatus {
			return sync.status;
		},
		subscribeSyncStatus(listener: (status: SyncStatus) => void) {
			requireOpen();
			return sync.subscribe(listener);
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			stopReplicaSubscription();
			sync.dispose();
			tableListeners.clear();
			valueListeners.clear();
			await documents[Symbol.asyncDispose]();
			await dispose();
		},
	});

	function listRows<TDefinition extends TableDefinition>(
		definition: TDefinition,
		compiled: ReturnType<typeof compileTableDefinition>,
		options: ListOptions<TDefinition>,
	): ListPage<TDefinition> {
		const limit = options.limit ?? DEFAULT_LIST_LIMIT;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
			throw new RangeError(
				`List limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
			);
		}
		const orderField = options.orderBy?.field ?? 'id';
		const direction = options.orderBy?.direction ?? 'asc';
		if (orderField !== 'id' && !compiled.fields.has(orderField)) {
			throw new Error(`Unknown order field '${orderField}'`);
		}
		if (direction !== 'asc' && direction !== 'desc') {
			throw new Error(`Invalid order direction '${direction}'`);
		}

		const where: string[] = [
			"address_kind = 'row'",
			'qualified_key = ?',
			"status = 'live'",
		];
		const parameters: SqliteValue[] = [definition.key];
		for (const [field, value] of Object.entries(options.where ?? {})) {
			if (value === undefined) {
				throw new TypeError(`Where field '${field}' cannot be undefined`);
			}
			if (field === 'id') {
				where.push('row_id = ?');
				parameters.push(value as string);
				continue;
			}
			const schema = compiled.fields.get(field);
			if (schema === undefined)
				throw new Error(`Unknown where field '${field}'`);
			if (!schema.check(value)) {
				throw new TypeError(`Invalid where value for '${field}'`);
			}
			where.push(
				'json_type(json_payload, ?) IS NOT NULL AND json_extract(json_payload, ?) IS ?',
			);
			parameters.push(`$.${field}`, `$.${field}`, sqliteValue(value));
		}

		const query = canonicalJson(options.where ?? {});
		const orderExpression =
			orderField === 'id'
				? 'row_id'
				: `json_extract(json_payload, '$.${orderField}')`;
		const cursor =
			options.cursor === undefined ? undefined : decodeCursor(options.cursor);
		if (cursor !== undefined) {
			if (
				cursor.key !== definition.key ||
				cursor.field !== orderField ||
				cursor.direction !== direction ||
				cursor.query !== query
			) {
				throw new Error('List cursor does not match this query');
			}
			where.push(cursorPredicate(orderExpression, direction, cursor.value));
			if (cursor.value === null) {
				parameters.push(cursor.id);
			} else {
				parameters.push(cursor.value, cursor.value, cursor.id);
			}
		}

		parameters.push(limit + 1);
		const stored = database.all<ListedStateRow>(
			`SELECT row_id, json_payload, ${orderExpression} AS order_value
			 FROM state
			 WHERE ${where.join(' AND ')}
			 ORDER BY ${orderExpression} ${direction.toUpperCase()}, row_id ASC
			 LIMIT ?`,
			parameters,
		);
		const hasNext = stored.length > limit;
		const pageRows = hasNext ? stored.slice(0, limit) : stored;
		const rows: RowFor<TDefinition>[] = [];
		const nonconforming: NonconformingRowError[] = [];
		for (const row of pageRows) {
			const payload = JSON.parse(row.json_payload) as JsonObject;
			const projected = compiled.project(row.row_id, payload);
			if (projected.error === null) {
				rows.push(projected.data as RowFor<TDefinition>);
			} else {
				nonconforming.push(projected.error);
			}
		}
		const last = pageRows.at(-1);
		return {
			rows,
			nonconforming,
			...(hasNext && last !== undefined
				? {
						nextCursor: encodeCursor({
							key: definition.key,
							field: orderField,
							direction,
							query,
							value: cursorValue(last.order_value),
							id: last.row_id,
						}),
					}
				: {}),
		};
	}
}

function cursorValue(value: SqliteValue): string | number | null {
	if (value instanceof Uint8Array) {
		throw new Error('List ordering produced an unsupported binary value');
	}
	return value;
}

export type Epicenter = ReturnType<typeof createEpicenter>;

function assertDefinitionGroup(
	tables: TableDefinitions,
	values: ValueDefinitions,
): void {
	const keys = new Map<string, string>();
	for (const [propertyName, definition] of Object.entries(tables)) {
		compileTableDefinition(definition);
		rememberDefinition(keys, definition.key, `tables.${propertyName}`);
	}
	for (const [propertyName, definition] of Object.entries(values)) {
		compileValueDefinition(definition);
		rememberDefinition(keys, definition.key, `values.${propertyName}`);
	}
}

function rememberDefinition(
	keys: Map<string, string>,
	key: string,
	propertyName: string,
): void {
	const existing = keys.get(key);
	if (existing !== undefined) {
		throw new Error(
			`Duplicate qualified key '${key}' is bound by '${existing}' and '${propertyName}'`,
		);
	}
	keys.set(key, propertyName);
}

function sqliteValue(value: unknown): SqliteValue {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'number'
	) {
		return value;
	}
	if (typeof value === 'boolean') return value ? 1 : 0;
	return JSON.stringify(value as JsonValue);
}

function cursorPredicate(
	expression: string,
	direction: 'asc' | 'desc',
	value: SqliteValue,
): string {
	if (value === null) {
		return direction === 'asc'
			? `((${expression}) IS NOT NULL OR ((${expression}) IS NULL AND row_id > ?))`
			: `((${expression}) IS NULL AND row_id > ?)`;
	}
	return direction === 'asc'
		? `((${expression}) > ? OR ((${expression}) IS ? AND row_id > ?))`
		: `((${expression}) < ? OR (${expression}) IS NULL OR ((${expression}) IS ? AND row_id > ?))`;
}

function encodeCursor(cursor: ListCursor): string {
	return encodeURIComponent(JSON.stringify(cursor));
}

function decodeCursor(cursor: string): ListCursor {
	try {
		const parsed = JSON.parse(
			decodeURIComponent(cursor),
		) as Partial<ListCursor>;
		if (
			typeof parsed.key !== 'string' ||
			typeof parsed.field !== 'string' ||
			(parsed.direction !== 'asc' && parsed.direction !== 'desc') ||
			typeof parsed.query !== 'string' ||
			typeof parsed.id !== 'string' ||
			parsed.value === undefined ||
			(typeof parsed.value !== 'string' &&
				typeof parsed.value !== 'number' &&
				parsed.value !== null)
		) {
			throw new Error('invalid cursor shape');
		}
		return parsed as ListCursor;
	} catch (cause) {
		throw new Error('Invalid list cursor', { cause });
	}
}
