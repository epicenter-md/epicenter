/**
 * @fileoverview Structured data, bound through one Lens the app declares.
 *
 * An app names its own durable namespace, its tables, and its values, and binds
 * them here. Nothing about that declaration is Epicenter's to own: a Lens is
 * inert JSON vocabulary from `@epicenter/lens`, which is why two apps can
 * import the same contract module and reach the same data without either of
 * them, or the contract, depending on this client.
 *
 * # Why `bind` is asynchronous
 *
 * The rest of this package has no opener, because there is no connection behind
 * recording or transcription. Data does have one. A bound handle promises to
 * report when its data may be stale, and that promise is only keepable if the
 * observation carrier is already established when the handle is handed over. A
 * synchronous `bind` would have to open the carrier lazily, which leaves a
 * window where an app has subscribed, read, and missed a change that landed in
 * between. Awaiting the bind closes that window at the one place a caller
 * already expects to wait.
 *
 * This does not reintroduce the `openEpicenter()` that ADR-0186 refused. There
 * is still no handle-wide session, no configuration, and no connection object
 * an app holds: `bind` is per Lens, and what it waits for is that Lens's
 * liveness.
 *
 * # Reading is a re-read, never a push
 *
 * Nothing here streams row contents. Invalidation says what may be stale; the
 * app re-reads through the handle it already has. That keeps one copy of the
 * data (the host's) and leaves the app in charge of what it caches.
 */

import {
	createInvalidationDispatcher,
	type ConstrainedUpdate,
	type CreateInputFor,
	type Lens,
	type NonconformingRowError,
	type RowFor,
	serializeTableDefinition,
	serializeValueDefinition,
	type TableDefinition,
	type TableDefinitions,
	type TableInvalidation,
	type ValueDefinition,
	type ValueDefinitions,
	type ValueFor,
} from '@epicenter/lens';
import { Err, Ok, type Result } from 'wellcrafted/result';

import {
	DATA_OBSERVE_ROUTE,
	DATA_ROUTE,
	type WireDataOperation,
	type WireDataResponse,
	type WireEntriesPage,
	type WireInvalidationFrame,
	type WireRowAddress,
	type WireValueAddress,
} from './data-protocol.js';
import {
	DataErrors,
	type BindDataError,
	type DataOperationError,
	type DataReadError,
	HostErrors,
} from './errors.js';

/** One classified traversal, grouped. */
export type TableScan<TDefinition extends TableDefinition> = {
	rows: RowFor<TDefinition>[];
	nonconforming: NonconformingRowError[];
};

/** One entry of a traversal: a row, or the reason it could not be read as one. */
export type TableEntry<TDefinition extends TableDefinition> = Result<
	RowFor<TDefinition>,
	NonconformingRowError
>;

/** Stop receiving invalidations. Calling it twice is a no-op. */
export type Unsubscribe = () => void;

export type TableHandle<TDefinition extends TableDefinition> = {
	create(
		fields: CreateInputFor<TDefinition>,
	): Promise<Result<RowFor<TDefinition>, DataOperationError>>;
	get(
		rowId: string,
	): Promise<Result<RowFor<TDefinition> | undefined, DataReadError>>;
	update<const TChanges extends Record<string, unknown>>(
		rowId: string,
		patch: TChanges & ConstrainedUpdate<TDefinition, TChanges>,
	): Promise<Result<RowFor<TDefinition> | undefined, DataReadError>>;
	/** `false` when the row was already gone, which is not a failure. */
	delete(rowId: string): Promise<Result<boolean, DataOperationError>>;
	/**
	 * Read every live row and group the results. Use {@link entries} when the
	 * table should not be held in memory all at once.
	 */
	scan(): Promise<Result<TableScan<TDefinition>, DataOperationError>>;
	/**
	 * Stream every live row in stable row-ID order without materializing the
	 * table. Paging is internal; a caller may stop early. Iteration throws only
	 * on transport failure, because a caller mid-loop has no Result to inspect.
	 */
	entries(): AsyncIterable<TableEntry<TDefinition>>;
	/**
	 * Report when rows reachable through this handle may be stale.
	 *
	 * Registration is synchronous, does no I/O, and never fires initially, so
	 * subscribing and then reading is race-free with nothing to discard.
	 *
	 * `{ scope: 'rows' }` names exactly the rows a commit touched.
	 * `{ scope: 'table' }` means the handle cannot name them, so everything
	 * reachable through it may have moved; it arrives after an observation gap,
	 * where a row deleted while the carrier was down has left nothing to name.
	 *
	 * Ignoring the payload and re-reading everything is always correct.
	 *
	 * @example
	 * ```ts
	 * const stop = notes.subscribe((invalidation) => {
	 *   if (invalidation.scope === 'table') return void reloadEverything();
	 *   for (const rowId of invalidation.rowIds) void reread(rowId);
	 * });
	 * ```
	 */
	subscribe(listener: (invalidation: TableInvalidation) => void): Unsubscribe;
};

export type ValueHandle<TDefinition extends ValueDefinition> = {
	get(): Promise<Result<ValueFor<TDefinition> | undefined, DataReadError>>;
	set(
		value: ValueFor<TDefinition>,
	): Promise<Result<void, DataOperationError>>;
	unset(): Promise<Result<void, DataOperationError>>;
	/**
	 * Report when this value may be stale.
	 *
	 * No payload, because a value has no smaller identity to name: the handle
	 * already is the thing that changed. Re-read to find out what it holds.
	 */
	subscribe(listener: () => void): Unsubscribe;
};

export type BoundData<
	TTables extends TableDefinitions,
	TValues extends ValueDefinitions,
> = {
	tables: { [K in keyof TTables]: TableHandle<TTables[K]> };
	values: { [K in keyof TValues]: ValueHandle<TValues[K]> };
	/**
	 * Release this binding's observation carrier.
	 *
	 * An app that lives as long as its window never needs this; a surface that
	 * binds and unbinds does.
	 */
	close(): Promise<void>;
};

export type DataNamespace = {
	/**
	 * Bind one Lens and wait for its liveness to be established.
	 *
	 * Outside an Epicenter host this answers `HostUnavailable`, like every other
	 * capability here, rather than throwing or handing back a handle that will
	 * fail on first use.
	 */
	bind<
		const TTables extends TableDefinitions,
		const TValues extends ValueDefinitions,
	>(
		lens: Lens<TTables, TValues>,
	): Promise<Result<BoundData<TTables, TValues>, BindDataError>>;
};

/**
 * Whether an Epicenter host is reachable from here.
 *
 * The same question `host.ts` asks, and the same answer: `__TAURI_INTERNALS__`
 * is present exactly when this document was served by an Epicenter host, so it
 * decides whether the same-origin data route exists at all. Asking it first
 * turns a browser tab's confusing 404 into a typed `HostUnavailable`.
 */
function hostIsReachable(): boolean {
	if (typeof window === 'undefined') return false;
	const internals = Reflect.get(window, '__TAURI_INTERNALS__');
	return typeof internals === 'object' && internals !== null;
}

function originOf(): string {
	const origin = (globalThis as { location?: { origin?: unknown } }).location
		?.origin;
	if (typeof origin !== 'string') {
		throw new Error('Epicenter data requires a document origin');
	}
	return origin;
}

function observeUrl(origin: string): string {
	const url = new URL(DATA_OBSERVE_ROUTE, origin);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	return url.toString();
}

/**
 * Read one carrier frame, or nothing when the host said something this client
 * does not recognize. An unreadable frame is dropped rather than thrown: the
 * carrier's job is liveness, and killing the socket over one bad message would
 * turn a cosmetic mismatch into a surface that stops updating.
 */
function parseFrame(data: unknown): WireInvalidationFrame | undefined {
	if (typeof data !== 'string') return undefined;
	try {
		const parsed: unknown = JSON.parse(data);
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			!('type' in parsed) ||
			parsed.type !== 'invalidation' ||
			!('changes' in parsed) ||
			!Array.isArray(parsed.changes)
		) {
			return undefined;
		}
		return parsed as WireInvalidationFrame;
	} catch {
		return undefined;
	}
}

/**
 * Split a patch into what to write and what to remove.
 *
 * `JSON.stringify` drops a key whose value is `undefined`, so a patch crossing
 * this carrier cannot say "remove this optional field" by holding one. The two
 * halves are named instead. Field names are not judged here: the host owns that
 * and reports it as an ordinary failure, and refusing early would turn a typed
 * decline into a thrown error.
 */
function splitUpdate(patch: Record<string, unknown>): {
	set: Record<string, unknown>;
	unset: string[];
} {
	const set: Record<string, unknown> = {};
	const unset: string[] = [];
	for (const [name, value] of Object.entries(patch)) {
		if (value === undefined) unset.push(name);
		else set[name] = value;
	}
	return { set, unset };
}

/**
 * Backoff for a loopback socket whose server is the same process tree.
 *
 * Short at the start because the common cause is the host restarting, which
 * takes milliseconds; capped low because a surface that stays dark after sleep
 * or wake is far worse than a few extra localhost dials.
 */
function reconnectDelayMs(attempt: number): number {
	return Math.min(250 * 2 ** (attempt - 1), 5_000);
}

/** The one data namespace. */
export const data: DataNamespace = { bind };

async function bind<
	const TTables extends TableDefinitions,
	const TValues extends ValueDefinitions,
>(
	lens: Lens<TTables, TValues>,
): Promise<Result<BoundData<TTables, TValues>, BindDataError>> {
	if (!hostIsReachable()) {
		return HostErrors.HostUnavailable({ operation: 'data.bind' });
	}
	const origin = originOf();
	const surfaceId = crypto.randomUUID();
	const observation = createInvalidationDispatcher();
	let isClosed = false;

	async function call<TResult>(
		operation: WireDataOperation,
	): Promise<Result<TResult, DataOperationError>> {
		if (isClosed) {
			return DataErrors.DataFailed({
				operation: operation.kind,
				cause: new Error('This data binding is closed'),
			});
		}
		let envelope: WireDataResponse;
		let status: number;
		try {
			const response = await fetch(new URL(DATA_ROUTE, origin), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ surfaceId, operation }),
			});
			status = response.status;
			envelope = (await response.json()) as WireDataResponse;
		} catch (cause) {
			return DataErrors.DataFailed({ operation: operation.kind, cause });
		}
		if (envelope.error !== null) {
			// The host answers a missing data owner and a refused operation the
			// same way it answers a bad patch: a named error. Only the first is a
			// claim about the system, so only the first becomes "unavailable".
			return envelope.error.name === 'DesktopEpicenterUnavailable'
				? DataErrors.DataUnavailable({ message: envelope.error.message })
				: DataErrors.DataFailed({
						operation: operation.kind,
						cause: `${envelope.error.name}: ${envelope.error.message}`,
					});
		}
		if (status >= 400) {
			return DataErrors.DataFailed({
				operation: operation.kind,
				cause: new Error(`Epicenter data answered HTTP ${status}`),
			});
		}
		return Ok(envelope.data as TResult);
	}

	// The carrier is established before this function resolves. That ordering is
	// the whole reason `bind` is asynchronous: once a caller holds the handle,
	// subscribing and then reading cannot straddle a gap.
	let socket: WebSocket | undefined;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let failedAttempts = 0;

	function connect({ isInitial }: { isInitial: boolean }): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			if (isClosed || typeof WebSocket === 'undefined') return resolve(false);
			let settled = false;
			const next = new WebSocket(observeUrl(origin));
			socket = next;
			next.addEventListener('open', () => {
				failedAttempts = 0;
				if (!settled) {
					settled = true;
					resolve(true);
				}
				// Only a reopen has handles to heal. The first carrier precedes every
				// subscription this binding can have, so there is nothing to tell.
				if (!isInitial) observation.invalidateAll();
			});
			next.addEventListener('message', (event: MessageEvent) => {
				const frame = parseFrame(event.data);
				if (frame !== undefined) observation.deliver(frame.changes);
			});
			// `error` always precedes `close` on a failed dial, so scheduling the
			// redial from `close` alone covers both without double-dialing.
			next.addEventListener('error', () => undefined);
			next.addEventListener('close', () => {
				if (socket !== next) return;
				socket = undefined;
				if (isClosed) return;
				failedAttempts += 1;
				if (!settled) {
					settled = true;
					resolve(false);
				}
				scheduleReconnect();
			});
		});
	}

	function scheduleReconnect(): void {
		if (isClosed || reconnectTimer !== undefined) return;
		reconnectTimer = setTimeout(
			() => {
				reconnectTimer = undefined;
				if (!isClosed) void connect({ isInitial: false });
			},
			reconnectDelayMs(Math.max(failedAttempts, 1)),
		);
	}

	const opened = await call<void>({ kind: 'open' });
	if (opened.error !== null) return Err(opened.error);
	if (!(await connect({ isInitial: true }))) {
		isClosed = true;
		return DataErrors.DataUnavailable({
			message:
				'Epicenter is present but its data observation carrier would not open, so a bound handle could not promise to report changes.',
		});
	}

	const tables = Object.fromEntries(
		Object.entries(lens.tables).map(([tableName, definition]) => [
			tableName,
			createTableHandle(lens.namespace, tableName, definition),
		]),
	);
	const values = Object.fromEntries(
		Object.entries(lens.values).map(([valueName, definition]) => [
			valueName,
			createValueHandle(lens.namespace, valueName, definition),
		]),
	);

	const bound: BoundData<TTables, TValues> = {
		tables: Object.freeze(tables) as BoundData<TTables, TValues>['tables'],
		values: Object.freeze(values) as BoundData<TTables, TValues>['values'],
		async close() {
			if (isClosed) return;
			isClosed = true;
			clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
			socket?.close();
			socket = undefined;
			observation.clear();
			// Deliberately after `isClosed`, and deliberately not routed through
			// `call`: the host should hear that this surface is gone even though no
			// further operation may be issued.
			await fetch(new URL(DATA_ROUTE, origin), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({
					surfaceId,
					operation: { kind: 'disconnect' },
				}),
			}).catch(() => undefined);
		},
	};
	return Ok(Object.freeze(bound));

	function createTableHandle<TDefinition extends TableDefinition>(
		namespace: string,
		tableName: string,
		definition: TDefinition,
	): TableHandle<TDefinition> {
		const wire = serializeTableDefinition(namespace, tableName, definition);
		const addressOf = (rowId: string): WireRowAddress => ({
			kind: 'row',
			namespace,
			tableName,
			rowId,
		});

		async function* entries(): AsyncIterable<TableEntry<TDefinition>> {
			let after: string | undefined;
			do {
				const page = await call<WireEntriesPage>({
					kind: 'table-entries-page',
					definition: wire,
					...(after === undefined ? {} : { after }),
				});
				if (page.error !== null) throw page.error;
				// The host already classified each entry as an ordinary Result; this
				// only names the row type the caller's Lens gives it.
				const entries = page.data.entries as TableEntry<TDefinition>[];
				for (const entry of entries) yield entry;
				after = page.data.nextAfter;
			} while (after !== undefined);
		}

		return Object.freeze({
			create: (fields: CreateInputFor<TDefinition>) =>
				call<RowFor<TDefinition>>({
					kind: 'table-create',
					definition: wire,
					fields: fields as Record<string, unknown>,
				}),
			async get(rowId: string) {
				const answered = await call<
					Result<RowFor<TDefinition> | undefined, NonconformingRowError>
				>({ kind: 'table-get', definition: wire, address: addressOf(rowId) });
				return answered.error !== null ? Err(answered.error) : answered.data;
			},
			async update<const TChanges extends Record<string, unknown>>(
				rowId: string,
				patch: TChanges & ConstrainedUpdate<TDefinition, TChanges>,
			) {
				const answered = await call<
					Result<RowFor<TDefinition> | undefined, NonconformingRowError>
				>({
					kind: 'table-update',
					definition: wire,
					address: addressOf(rowId),
					...splitUpdate(patch),
				});
				return answered.error !== null ? Err(answered.error) : answered.data;
			},
			delete: (rowId: string) =>
				call<boolean>({
					kind: 'table-delete',
					definition: wire,
					address: addressOf(rowId),
				}),
			async scan() {
				const rows: RowFor<TDefinition>[] = [];
				const nonconforming: NonconformingRowError[] = [];
				try {
					for await (const entry of entries()) {
						if (entry.error === null) rows.push(entry.data);
						else nonconforming.push(entry.error);
					}
				} catch (cause) {
					return cause !== null &&
						typeof cause === 'object' &&
						'name' in cause &&
						'message' in cause
						? Err(cause as DataOperationError)
						: DataErrors.DataFailed({ operation: 'table-scan', cause });
				}
				return Ok({ rows, nonconforming });
			},
			entries,
			subscribe: (listener: (invalidation: TableInvalidation) => void) =>
				observation.subscribeTable(namespace, tableName, listener),
		}) as TableHandle<TDefinition>;
	}

	function createValueHandle<TDefinition extends ValueDefinition>(
		namespace: string,
		valueName: string,
		definition: TDefinition,
	): ValueHandle<TDefinition> {
		const address: WireValueAddress = { kind: 'value', namespace, valueName };
		const wire = serializeValueDefinition(address, definition);
		return Object.freeze({
			async get() {
				const answered = await call<
					Result<ValueFor<TDefinition> | undefined, DataReadError>
				>({ kind: 'value-get', definition: wire, address });
				return answered.error !== null ? Err(answered.error) : answered.data;
			},
			set: (value: ValueFor<TDefinition>) =>
				call<void>({ kind: 'value-set', definition: wire, address, value }),
			unset: () => call<void>({ kind: 'value-unset', definition: wire, address }),
			subscribe: (listener: () => void) =>
				observation.subscribeValue(address, listener),
		}) as ValueHandle<TDefinition>;
	}
}
