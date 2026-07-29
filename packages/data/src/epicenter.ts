import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import { customAlphabet } from 'nanoid';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';

import {
	type ConstrainedUpdate,
	type CreateInputFor,
	compileTableDefinition,
	compileValueDefinition,
	type DataReadError,
	type Lens,
	type NonconformingRowError,
	type RowFor,
	type TableDefinition,
	type TableDefinitions,
	type ValueDefinition,
	type ValueDefinitions,
	type ValueFor,
} from './definitions.js';
import {
	createDocumentRuntime,
	type PullDocument,
	type RowDocument,
} from './documents.js';
import {
	createInvalidationDispatcher,
	type TableInvalidation,
} from './observation.js';
import type {
	Address,
	JsonObject,
	RowAddress,
	ValueAddress,
} from './protocol/index.js';
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
	create(fields: CreateInputFor<TDefinition>): Promise<RowFor<TDefinition>>;
	get(id: string): Promise<Result<RowFor<TDefinition> | undefined, ReadError>>;
	update<const TChanges extends Record<string, unknown>>(
		id: string,
		patch: TChanges & ConstrainedUpdate<TDefinition, TChanges>,
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

export type ValueLens<TDefinition extends ValueDefinition> = {
	get(): Promise<Result<ValueFor<TDefinition> | undefined, ReadError>>;
	set(value: ValueFor<TDefinition>): Promise<void>;
	unset(): Promise<void>;
	/**
	 * Report when this value may be stale.
	 *
	 * The listener takes no payload because a value has no smaller identity to
	 * name: the handle already is the thing that changed. Re-read through
	 * {@link ValueLens.get} to find out what it now holds.
	 */
	subscribe(listener: () => void): () => void;
};

export type BoundData<
	TTables extends TableDefinitions,
	TValues extends ValueDefinitions,
> = {
	tables: { [K in keyof TTables]: TableLens<TTables[K]> };
	values: { [K in keyof TValues]: ValueLens<TValues[K]> };
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
	const commitListeners = new Set<(changes: readonly Address[]) => void>();
	let isDisposed = false;

	function requireOpen(): void {
		if (isDisposed) throw new Error('Epicenter is disposed');
	}

	const stopReplicaSubscription = replica.subscribe((changes) => {
		for (const address of changes) {
			if (address.kind === 'value') continue;
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
	 * Each `tables` and `values` property name becomes the durable local key of
	 * the address it reads and writes, under the Lens's single declared
	 * namespace.
	 */
	function bind<
		const TTables extends TableDefinitions,
		const TValues extends ValueDefinitions,
	>(lens: Lens<TTables, TValues>): BoundData<TTables, TValues> {
		requireOpen();
		const boundTables = Object.fromEntries(
			Object.entries(lens.tables).map(([tableName, definition]) => [
				tableName,
				createTableLens(lens.namespace, tableName, definition),
			]),
		);
		const boundValues = Object.fromEntries(
			Object.entries(lens.values).map(([valueName, definition]) => [
				valueName,
				createValueLens(lens.namespace, valueName, definition),
			]),
		);
		return Object.freeze({
			tables: Object.freeze(boundTables),
			values: Object.freeze(boundValues),
		}) as BoundData<TTables, TValues>;
	}

	function createTableLens<TDefinition extends TableDefinition>(
		namespace: string,
		tableName: string,
		definition: TDefinition,
	): TableLens<TDefinition> {
		const compiled = compileTableDefinition(definition);
		const addressOf = (rowId: string): RowAddress => ({
			kind: 'row',
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
			async create(input: Record<string, unknown>) {
				requireOpen();
				const fields = compiled.validateCreate(input);
				const address = addressOf(mintRowId());
				const written = replica.write({
					verb: 'patch',
					address,
					set: fields,
					unset: [],
				});
				if (written.error !== null) throw written.error;
				if (!written.data.applied) {
					// A freshly minted row id has no fact, so a refused patch means the
					// address is already occupied or already a tombstone. Either way the
					// mint collided, which a 24-character random id should never do.
					throw new Error(
						`Minted row '${namespace}/${tableName}/${address.rowId}' is already taken`,
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
			async update(id: string, input: Record<string, unknown>) {
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

	function createValueLens<TDefinition extends ValueDefinition>(
		namespace: string,
		valueName: string,
		definition: TDefinition,
	): ValueLens<TDefinition> {
		const compiled = compileValueDefinition(definition);
		const address: ValueAddress = { kind: 'value', namespace, valueName };
		return Object.freeze({
			async get() {
				requireOpen();
				const stored = replica.readValue(address);
				if (stored.error !== null) return stored;
				return stored.data === undefined
					? Ok(undefined)
					: compiled.project(address, stored.data);
			},
			async set(content: unknown) {
				requireOpen();
				const written = replica.write({
					verb: 'set',
					address,
					content: compiled.validate(content),
				});
				if (written.error !== null) throw written.error;
			},
			async unset() {
				requireOpen();
				const written = replica.write({ verb: 'unset', address });
				if (written.error !== null) throw written.error;
			},
			subscribe(listener: () => void) {
				requireOpen();
				return observation.subscribeValue(address, listener);
			},
		}) as ValueLens<TDefinition>;
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
			listener: (changes: readonly Address[]) => void,
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
				kind: 'row',
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
