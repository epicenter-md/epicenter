import {
	type ConstrainedUpdate,
	type CreateInputFor,
	compileTableDefinition,
	createInvalidationDispatcher,
	DATA_ADDRESS_CEILINGS,
	type DataReadError,
	defineLens,
	defineTable,
	isRowId,
	type Lens,
	type NonconformingRowError,
	optional,
	type RowFor,
	type SerializedTableDefinition,
	type TableDefinition,
	type TableDefinitions,
	type TableInvalidation,
} from '@epicenter/lens';
import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import { customAlphabet } from 'nanoid';
import type { TSchema } from 'typebox';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';

import {
	createDocumentRuntime,
	type PullDocument,
	type RowDocument,
} from './documents.js';
import type { JsonObject, RowAddress } from './protocol/index.js';
import type { Replica, ReplicaError } from './replica/index.js';
import {
	createSyncSupervisor,
	type SyncSchedule,
	type SyncStatus,
	type SyncSupervisorSession,
} from './sync-supervisor.js';

const mintRowId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);
const ENTRIES_PAGE_SIZE = 100;

type ReadError = DataReadError | ReplicaError;

export type TableScan<TDefinition extends TableDefinition> = {
	rows: RowFor<TDefinition>[];
	nonconforming: NonconformingRowError[];
};

export type TableEntry<TDefinition extends TableDefinition> = Result<
	RowFor<TDefinition>,
	NonconformingRowError
>;

export type TableLens<TDefinition extends TableDefinition> = {
	/**
	 * Bring one row into being.
	 *
	 * Two doors, and which one you take is only whether you already know the id.
	 * Without one the runtime mints it; with one you supply it, which is how a
	 * singleton reaches the same address on every device without coordinating
	 * (ADR-0206).
	 *
	 * This is the one verb that creates, because it is the one moment the type
	 * system can demand a complete row. `patch` is partial by nature and refuses
	 * an address that holds no live fact, so an id you already deleted stays
	 * deleted rather than being resurrected by a write.
	 */
	create(fields: CreateInputFor<TDefinition>): Promise<RowFor<TDefinition>>;
	create(
		rowId: string,
		fields: CreateInputFor<TDefinition>,
	): Promise<RowFor<TDefinition>>;
	get(id: string): Promise<Result<RowFor<TDefinition> | undefined, ReadError>>;
	patch<const TChanges extends Record<string, unknown>>(
		id: string,
		changes: TChanges & ConstrainedUpdate<TDefinition, TChanges>,
	): Promise<Result<RowFor<TDefinition> | undefined, ReadError>>;
	delete(id: string): Promise<boolean>;
	/**
	 * Consume the classified traversal to completion and group its results.
	 *
	 * Use this when the traversal belongs in memory, such as a local UI cache.
	 * Use {@link entries} for repair, export, or another workflow that should
	 * keep memory bounded while it visits every live row. Like `entries()`, this
	 * observes live state rather than a point-in-time snapshot.
	 * Storage or transport failure rejects the returned Promise; only row Lens
	 * projection failures are grouped under `nonconforming`.
	 *
	 * @example
	 * ```ts
	 * const { rows, nonconforming } = await notes.scan();
	 * ```
	 */
	scan(): Promise<TableScan<TDefinition>>;
	/**
	 * Stream every live row in stable row-ID order without materializing the
	 * table. The runtime fetches bounded internal batches and keeps continuation
	 * state private; callers may stop iteration early.
	 *
	 * Entries are ordinary Results: conforming rows are `Ok`, while rows that the
	 * current Lens cannot interpret are `Err(NonconformingRow)` with raw JSON.
	 * The traversal observes live state rather than a database snapshot.
	 * Storage or transport failure throws from iteration instead of becoming an
	 * `Err` entry.
	 *
	 * @example
	 * ```ts
	 * for await (const entry of notes.entries()) {
	 *   if (entry.error !== null) report(entry.error);
	 * }
	 * ```
	 */
	entries(): AsyncIterable<TableEntry<TDefinition>>;
	/**
	 * Report when rows reachable through this handle may be stale.
	 *
	 * Registration is synchronous, does no I/O, and never fires initially, so
	 * subscribing and then reading is race-free without a first delivery to
	 * discard. See {@link TableInvalidation} for the laws the payload obeys.
	 *
	 * @example
	 * ```ts
	 * const stop = notes.subscribe((invalidation) => {
	 *   if (invalidation.scope === 'table') return void reload();
	 *   for (const id of invalidation.rowIds) void reread(id);
	 * });
	 * ```
	 */
	subscribe(listener: (invalidation: TableInvalidation) => void): () => void;
	openDocument(rowId: string): Promise<RowDocument>;
};

/**
 * One bound Lens: its tables, reached by their declared names.
 *
 * There is no `tables` level, because there is nothing to sit beside it. A Lens
 * declares tables and fields and nothing else (ADR-0206), so a container with
 * one member would be a level that only ever holds one thing.
 */
export type BoundData<TTables extends TableDefinitions> = {
	[K in keyof TTables]: TableLens<TTables[K]>;
};

export type EpicenterSyncSession = SyncSupervisorSession & {
	deploymentId: string;
	principalId: string;
	/**
	 * The session's inbound HTTP carrier for explicit document pulls. Owned
	 * here rather than by the supervisor: the supervisor drives outbound
	 * drains, while pulls are application-driven through open handles. When
	 * absent, `document.pull()` reports that no attached session can pull.
	 */
	pullDocument?: PullDocument;
};

export type CreateEpicenterOptions = {
	replica: Replica;
	database: SqliteDatabase;
	dispose?: () => void | Promise<void>;
	log?: Logger;
	syncIntervalMs?: number;
	scheduleSync?: SyncSchedule;
};

type StoredRowFact = SqliteRow & {
	row_id: string;
	fields: string;
};

export type TableEntriesPage<TDefinition extends TableDefinition> = {
	entries: TableEntry<TDefinition>[];
	nextAfter?: string;
};

export const readTableEntriesPage: unique symbol = Symbol(
	'epicenter.readTableEntriesPage',
);

/**
 * The committed-address stream, for the one host that has to forward it.
 *
 * Symbol-keyed for the same reason {@link readTableEntriesPage} is: an
 * application surface holds a `BoundData`, and a raw `Address[]` stream is not
 * something it should ever be able to reach. Only the process that constructed
 * this runtime can name this symbol, and the only thing it does with the
 * stream is put it on a carrier for surfaces that are not in this process.
 *
 * Subscribers here see exactly what the replica emitted: one batch per commit,
 * across every namespace this runtime holds. Filtering to a Lens is the
 * client's job, because only the client knows which handles exist.
 */
export const subscribeCommittedAddresses: unique symbol = Symbol(
	'epicenter.subscribeCommittedAddresses',
);

export type InternalTableLens<TDefinition extends TableDefinition> =
	TableLens<TDefinition> & {
		[readTableEntriesPage](
			after?: string,
		): Promise<TableEntriesPage<TDefinition>>;
	};

export function createTableReadMethods<TDefinition extends TableDefinition>(
	readPage: (after?: string) => Promise<TableEntriesPage<TDefinition>>,
): Pick<TableLens<TDefinition>, 'scan' | 'entries'> {
	async function* entries(): AsyncIterable<TableEntry<TDefinition>> {
		let after: string | undefined;
		do {
			const page = await readPage(after);
			yield* page.entries;
			after = page.nextAfter;
		} while (after !== undefined);
	}

	return {
		async scan() {
			const rows: RowFor<TDefinition>[] = [];
			const nonconforming: NonconformingRowError[] = [];
			for await (const entry of entries()) {
				if (entry.error === null) rows.push(entry.data);
				else nonconforming.push(entry.error);
			}
			return { rows, nonconforming };
		},
		entries,
	};
}

/**
 * One table as an RPC host sees it: named on the wire, so its field types are
 * gone by the time the host holds it.
 *
 * A host proxies for a surface that owns the real Lens, and only that surface
 * can say what a row means. The host's whole job is to route the call and hand
 * back whatever came out, so `unknown` is the honest return: it is the same
 * value the typed handle on the other side already knows how to read.
 */
export type UntypedTableLens = {
	/**
	 * Both doors, because a host proxies for a surface that has both.
	 *
	 * A chosen id is the only way an application reaches a singleton, and every
	 * proxied surface (the browser page, the desktop surface) creates one at
	 * boot. Declaring one door here made both RPC hosts cast their way to the
	 * other, and a cast to a two-parameter function does not give a
	 * one-parameter forwarder a second parameter: the id arrived as the fields
	 * and the fields were dropped.
	 */
	create(fields: Record<string, unknown>): Promise<unknown>;
	create(rowId: string, fields: Record<string, unknown>): Promise<unknown>;
	get(rowId: string): Promise<unknown>;
	patch(rowId: string, changes: Record<string, unknown>): Promise<unknown>;
	delete(rowId: string): Promise<boolean>;
	entriesPage(after?: string): Promise<unknown>;
	openDocument(rowId: string): Promise<RowDocument>;
};

function deserializeTable(
	definition: SerializedTableDefinition,
): TableDefinition {
	const fields: Record<string, TSchema> = {};
	const optionalFields = new Set(definition.optionalFields);
	for (const [name, schema] of Object.entries(definition.fields)) {
		const typedSchema = schema as TSchema;
		fields[name] = optionalFields.has(name)
			? optional(typedSchema)
			: typedSchema;
	}
	return defineTable({ fields });
}

/**
 * Rebuild one wire-named table into a bound handle an RPC host can call.
 *
 * Lives here, beside {@link readTableEntriesPage}, because it is the only thing
 * that needs that symbol: a host reaches the page reader through `entriesPage`
 * and never learns the symbol exists. Both RPC hosts (the browser worker and
 * the desktop owner) used to carry their own copy of this reconstruction, which
 * meant two places had to agree that the serialized table name is the durable
 * local key.
 *
 * That name is the whole reason the Lens is rebuilt under `definition.table`
 * rather than a fixed placeholder: the property name IS the address, so binding
 * every proxied table under one placeholder would address them all identically.
 */
export function bindSerializedTable(
	epicenter: Epicenter,
	definition: SerializedTableDefinition,
): UntypedTableLens {
	const bound = epicenter.bind(
		defineLens({
			namespace: definition.namespace,
			tables: { [definition.table]: deserializeTable(definition) },
		}),
	)[definition.table] as InternalTableLens<TableDefinition>;
	return {
		create: (
			first: string | Record<string, unknown>,
			second?: Record<string, unknown>,
		) =>
			typeof first === 'string'
				? bound.create(first, second as Record<string, unknown>)
				: bound.create(first),
		get: (rowId) => bound.get(rowId),
		patch: (rowId, changes) => bound.patch(rowId, changes),
		delete: (rowId) => bound.delete(rowId),
		entriesPage: (after) => bound[readTableEntriesPage](after),
		openDocument: (rowId) => bound.openDocument(rowId),
	};
}

/** Create the adapter-agnostic Data runtime over one already-open replica. */
export function createEpicenter({
	replica,
	database,
	dispose = () => undefined,
	log = createLogger('data'),
	syncIntervalMs,
	scheduleSync,
}: CreateEpicenterOptions) {
	let activeSession: EpicenterSyncSession | undefined;
	const documents = createDocumentRuntime({
		database,
		replica,
		getPullTransport: () => {
			const transport = activeSession?.pullDocument;
			if (transport === undefined) return undefined;
			return async (request) => {
				const response = await transport(request);
				// A pull that finds the row dead converges through the scalar
				// row-liveness owner: the next exchange installs the deletion
				// and revokes the document.
				if (response.kind === 'not-live') void sync.requestExchange();
				return response;
			};
		},
	});
	const sync = createSyncSupervisor({
		replica,
		// Documents drain under the supervisor's one scheduler, retry policy,
		// and status surface: after the scalar exchange in a full cycle, and
		// alone in a coalesced document-only wake.
		drainDocuments: (session) => {
			const publish = session.publishDocument;
			if (publish === undefined) return Promise.resolve(Ok(undefined));
			return documents.drainPublications(async (request) => {
				const outcome = await publish(request);
				// A dead row converges through the scalar row-liveness owner; ask
				// for the exchange that installs the deletion promptly instead of
				// waiting for the periodic cycle.
				if (outcome === 'not-live') void sync.requestExchange();
				return outcome;
			});
		},
		...(syncIntervalMs === undefined
			? {}
			: { exchangeIntervalMs: syncIntervalMs }),
		...(scheduleSync === undefined ? {} : { schedule: scheduleSync }),
		log,
	});
	// A committed local document append wakes the coalesced document drain;
	// a later runtime resumes unfinished work from SQLite without waiting for
	// this signal.
	const stopPublicationWake = documents.subscribePublicationDirty(() => {
		sync.requestDocumentDrain();
	});
	const observation = createInvalidationDispatcher({ log });
	const commitListeners = new Set<(changes: readonly RowAddress[]) => void>();
	let isDisposed = false;

	function requireOpen(): void {
		if (isDisposed) throw new Error('Epicenter is disposed');
	}

	const stopReplicaSubscription = replica.subscribe((changes) => {
		for (const address of changes) {
			const current = replica.readRow(address);
			if (current.error !== null) {
				// Liveness is unknowable this pass, so the open document keeps
				// running rather than being revoked on a guess. Reported because
				// this read is what a pull's `RowNotLive` is waiting on: left
				// silent, a document the authority already called dead would stay
				// open with nothing to say why.
				log.error(current.error);
			} else if (current.data === undefined) {
				documents.revoke(address);
			}
		}
		// Delivered after the liveness sweep, so a listener that re-reads on
		// invalidation cannot observe a row whose document is still open while
		// the replica already calls it dead.
		observation.deliver(changes);
		if (changes.length === 0) return;
		for (const listener of [...commitListeners]) {
			try {
				listener(changes);
			} catch (cause) {
				log.error(new Error('Committed-address forwarder threw', { cause }));
			}
		}
	});

	/**
	 * Bind one Lens over this runtime's replica.
	 *
	 * Each `tables` property name becomes the durable local key of the address it
	 * reads and writes, under the Lens's single declared namespace.
	 */
	function bind<const TTables extends TableDefinitions>(
		lens: Lens<TTables>,
	): BoundData<TTables> {
		requireOpen();
		return Object.freeze(
			Object.fromEntries(
				Object.entries(lens.tables).map(([tableName, definition]) => [
					tableName,
					createTableLens(lens.namespace, tableName, definition),
				]),
			),
		) as BoundData<TTables>;
	}

	function createTableLens<TDefinition extends TableDefinition>(
		namespace: string,
		tableName: string,
		definition: TDefinition,
	): TableLens<TDefinition> {
		const compiled = compileTableDefinition(definition);
		const addressOf = (rowId: string): RowAddress => ({
			namespace,
			tableName,
			rowId,
		});
		const readEntriesPage = async (after?: string) => {
			requireOpen();
			return readEntriesPageFromDatabase(
				namespace,
				tableName,
				compiled,
				after,
			) as TableEntriesPage<TDefinition>;
		};

		const tableLens = {
			async create(
				first: string | Record<string, unknown>,
				second?: Record<string, unknown>,
			) {
				requireOpen();
				const suppliedId = typeof first === 'string' ? first : undefined;
				if (
					suppliedId !== undefined &&
					!isRowId(suppliedId, DATA_ADDRESS_CEILINGS)
				) {
					// Refused here rather than at the storage CHECK, because this is the
					// boundary an application-chosen name crosses and the only place a
					// caller can still be told which name was wrong.
					throw new Error(
						`Invalid row id '${suppliedId}'; start with a letter or digit and use letters, digits, '.', '-', and '_'`,
					);
				}
				const input = (suppliedId === undefined ? first : second) as Record<
					string,
					unknown
				>;
				const fields = compiled.validateCreate(input);
				const address = addressOf(suppliedId ?? mintRowId());
				if (suppliedId !== undefined) {
					// A create is lowered to a patch, and a patch over a live row
					// merges rather than refusing, so a supplied id needs this read to
					// keep `create` meaning create. The read and the write are not
					// separated by an await, so nothing can land between them.
					const existing = replica.readRow(address);
					if (existing.error !== null) throw existing.error;
					if (existing.data !== undefined) {
						throw new Error(
							`Row '${namespace}/${tableName}/${address.rowId}' already exists`,
						);
					}
				}
				const written = replica.write({
					verb: 'patch',
					address,
					set: fields,
					unset: [],
				});
				if (written.error !== null) throw written.error;
				if (!written.data.applied) {
					// The live case is already refused above, so a patch refused here
					// means a tombstone: deletion is terminal, and a name that was
					// deleted is dead on every device forever (ADR-0206). For a minted
					// id it means the mint collided, which a 24-character random id
					// should never do.
					throw new Error(
						suppliedId === undefined
							? `Minted row '${namespace}/${tableName}/${address.rowId}' is already taken`
							: `Row '${namespace}/${tableName}/${address.rowId}' was deleted, and a deleted name cannot be reused`,
					);
				}
				const projected = compiled.project(address, fields);
				if (projected.error !== null) throw projected.error;
				return projected.data;
			},
			async get(id: string) {
				requireOpen();
				const address = addressOf(id);
				const stored = replica.readRow(address);
				if (stored.error !== null) return stored;
				return stored.data === undefined
					? Ok(undefined)
					: compiled.project(address, stored.data);
			},
			async patch(id: string, input: Record<string, unknown>) {
				requireOpen();
				const patch = compiled.normalizeUpdate(input);
				const address = addressOf(id);
				const before = replica.readRow(address);
				if (before.error !== null) return before;
				if (before.data === undefined) return Ok(undefined);
				if (Object.keys(patch.set).length === 0 && patch.unset.length === 0) {
					return compiled.project(address, before.data);
				}
				const written = replica.write({
					verb: 'patch',
					address,
					set: patch.set,
					unset: patch.unset,
				});
				if (written.error !== null) return written;
				const current = replica.readRow(address);
				if (current.error !== null) return current;
				return current.data === undefined
					? Ok(undefined)
					: compiled.project(address, current.data);
			},
			async delete(id: string) {
				requireOpen();
				const address = addressOf(id);
				const before = replica.readRow(address);
				if (before.error !== null) throw before.error;
				if (before.data === undefined) return false;
				const written = replica.write({ verb: 'delete', address });
				if (written.error !== null) throw written.error;
				return written.data.applied;
			},
			...createTableReadMethods(readEntriesPage),
			[readTableEntriesPage]: readEntriesPage,
			subscribe(listener: (invalidation: TableInvalidation) => void) {
				requireOpen();
				return observation.subscribeTable(namespace, tableName, listener);
			},
			openDocument(rowId: string) {
				requireOpen();
				return documents.open(addressOf(rowId));
			},
		};
		return Object.freeze(tableLens) as InternalTableLens<TDefinition>;
	}

	async function attachSync(
		session: EpicenterSyncSession,
	): Promise<Result<void, ReplicaError>> {
		requireOpen();
		const attached = replica.attach(session);
		if (attached.error !== null) return attached;
		activeSession = session;
		return sync.attach(session);
	}

	return Object.freeze({
		bind,
		attachSync,
		[subscribeCommittedAddresses](
			listener: (changes: readonly RowAddress[]) => void,
		): () => void {
			requireOpen();
			commitListeners.add(listener);
			return () => commitListeners.delete(listener);
		},
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
			activeSession = undefined;
			stopReplicaSubscription();
			stopPublicationWake();
			sync.dispose();
			observation.clear();
			commitListeners.clear();
			await documents[Symbol.asyncDispose]();
			await dispose();
		},
	});

	function readEntriesPageFromDatabase(
		namespace: string,
		tableName: string,
		compiled: ReturnType<typeof compileTableDefinition>,
		after?: string,
	): TableEntriesPage<TableDefinition> {
		const where = ['namespace = ?', 'table_name = ?', "presence = 'present'"];
		const parameters: (string | number)[] = [namespace, tableName];
		if (after !== undefined) {
			where.push('row_id > ?');
			parameters.push(after);
		}
		parameters.push(ENTRIES_PAGE_SIZE + 1);
		const stored = database.all<StoredRowFact>(
			`SELECT row_id, fields
			 FROM main._replica_row_facts
			 WHERE ${where.join(' AND ')}
			 ORDER BY row_id ASC
			 LIMIT ?`,
			parameters,
		);
		const hasNext = stored.length > ENTRIES_PAGE_SIZE;
		const pageRows = hasNext ? stored.slice(0, ENTRIES_PAGE_SIZE) : stored;
		const entries: TableEntry<TableDefinition>[] = [];
		for (const row of pageRows) {
			const payload = JSON.parse(row.fields) as JsonObject;
			const address: RowAddress = {
				namespace,
				tableName,
				rowId: row.row_id,
			};
			entries.push(
				compiled.project(address, payload) as TableEntry<TableDefinition>,
			);
		}
		const last = pageRows.at(-1);
		return {
			entries,
			...(hasNext && last !== undefined ? { nextAfter: last.row_id } : {}),
		};
	}
}

/**
 * What any Epicenter engine offers a surface: the in-process runtime, the
 * browser page proxy, and the desktop surface proxy all satisfy this.
 *
 * The committed-address stream is deliberately not part of it. Only the process
 * that constructed a local runtime can forward commits onto a carrier, and a
 * proxy has no commits of its own to forward: it is on the receiving end of
 * someone else's. Leaving the symbol out of the shared type is what stops a
 * proxy from having to pretend it can answer.
 */
export type Epicenter = Omit<
	LocalEpicenter,
	typeof subscribeCommittedAddresses
>;

/** One Epicenter runtime over a replica in this process. */
export type LocalEpicenter = ReturnType<typeof createEpicenter>;
