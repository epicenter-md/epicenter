import * as Y from '@y/y';
import { createLogger, type Logger } from 'wellcrafted/logger';
import {
	type ConstrainedUpdate,
	type CreateInputFor,
	compileTableDefinition,
	compileValueDefinition,
	type Lens,
	type RowFor,
	type TableDefinition,
	type TableDefinitions,
	type ValueDefinition,
	type ValueDefinitions,
	type ValueFor,
} from './definitions.js';
import {
	type DesktopInvalidationFrame,
	type DesktopOperation,
	type DesktopRequest,
	type DesktopResponse,
	desktopEpicenterObserveUrl,
	desktopEpicenterUrl,
	type SerializedTableDefinition,
	type SerializedValueDefinition,
} from './desktop-protocol.js';
import {
	type RowDocument,
	registerRowDocumentConnectionTarget,
} from './documents.js';
import {
	type BoundData,
	createTableReadMethods,
	type TableEntriesPage,
	type TableLens,
	type ValueLens,
} from './epicenter.js';
import {
	createInvalidationDispatcher,
	type TableInvalidation,
} from './observation.js';
import type {
	JsonValue,
	RowAddress,
	ValueAddress,
} from './protocol/index.js';

/**
 * A socket this opener can drive. Narrower than `WebSocket` on purpose: the
 * carrier uses four events and two methods, and naming them is what lets a test
 * hand over a fake without a DOM.
 */
export type ObservationSocket = {
	addEventListener(type: 'open', listener: () => void): void;
	addEventListener(type: 'close', listener: () => void): void;
	addEventListener(type: 'error', listener: () => void): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: unknown }) => void,
	): void;
	close(): void;
};

export type OpenDesktopEpicenterOptions = {
	baseUrl?: string;
	fetch?: (
		input: Parameters<typeof globalThis.fetch>[0],
		init?: Parameters<typeof globalThis.fetch>[1],
	) => Promise<Response>;
	/**
	 * Open the observation carrier. Defaults to a same-origin `WebSocket`, whose
	 * session cookie and `Origin` header are what the host checks.
	 */
	createObservationSocket?(url: string): ObservationSocket;
	/**
	 * How long to wait before redialing after the carrier drops. Called with the
	 * number of consecutive failures, starting at 1.
	 */
	reconnectDelayMs?(attempt: number): number;
	log?: Logger;
};

/**
 * Backoff for a loopback socket whose server is the same process tree.
 *
 * Short at the start because the common cause is the host restarting its
 * server, which takes milliseconds; capped low because the cost of a redial
 * here is a localhost connection, and a surface that stays dark after sleep or
 * wake is a much worse outcome than a few extra attempts.
 */
function defaultReconnectDelayMs(attempt: number): number {
	return Math.min(250 * 2 ** (attempt - 1), 5_000);
}

const remoteDocumentOrigin = Object.freeze({ kind: 'desktop-document-remote' });

/**
 * Open one trusted WebView proxy to the Bun-owned desktop Epicenter.
 *
 * A surface reaches this by being compiled for the desktop host, never by
 * detecting one. The build that the host serves is selected by the `tauri`
 * resolve condition, so the module that names this opener is already the answer
 * to "is this a desktop surface"; asking the DOM the same question at runtime
 * would only be a second, weaker copy of a fact the bundler already fixed.
 */
export async function openDesktopEpicenter({
	baseUrl = defaultOrigin(),
	fetch: fetchInput = globalThis.fetch,
	createObservationSocket = defaultObservationSocket,
	reconnectDelayMs = defaultReconnectDelayMs,
	log = createLogger('data/desktop'),
}: OpenDesktopEpicenterOptions = {}) {
	const surfaceId = crypto.randomUUID();
	const observation = createInvalidationDispatcher({ log });
	const documents = new Set<RowDocument>();
	let isDisposed = false;

	function requireOpen(): void {
		if (isDisposed) throw new Error('Desktop Epicenter is disposed');
	}

	async function request<TResult>(
		operation: DesktopOperation,
	): Promise<TResult> {
		requireOpen();
		const response = await fetchInput(desktopEpicenterUrl(baseUrl), {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify({ surfaceId, operation } satisfies DesktopRequest),
		});
		const envelope = (await response.json()) as DesktopResponse;
		if (!response.ok || envelope.error !== null) {
			const cause = new Error(
				envelope.error?.message ?? `Desktop Epicenter HTTP ${response.status}`,
			);
			if (envelope.error !== null) cause.name = envelope.error.name;
			throw cause;
		}
		return envelope.data as TResult;
	}

	/**
	 * The observation carrier: one host-owned socket per surface.
	 *
	 * Every reconnection after the first is a gap. The wire cannot say what
	 * happened during it, and a deletion that landed while the socket was down
	 * leaves nothing behind to name, so on every reopen the client tells each
	 * handle it still holds the strongest honest thing it can: tables may be
	 * entirely stale, values may be stale. That is law 6, and it is why a
	 * transient drop self-heals instead of forcing an app reload.
	 */
	let socket: ObservationSocket | undefined;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let failedAttempts = 0;

	function connectObservation({
		isInitial,
	}: {
		isInitial: boolean;
	}): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (isDisposed) return resolve();
			let settled = false;
			const next = createObservationSocket(desktopEpicenterObserveUrl(baseUrl));
			socket = next;
			next.addEventListener('open', () => {
				failedAttempts = 0;
				if (!settled) {
					settled = true;
					resolve();
				}
				// Deliberately after the initial open too? No: the first carrier
				// precedes every subscription this surface can have made, so there
				// is nothing to tell. Only a reopen has handles to heal.
				if (!isInitial) observation.invalidateAll();
			});
			next.addEventListener('message', (event) => {
				const frame = parseInvalidationFrame(event.data);
				if (frame === undefined) return;
				observation.deliver(frame.changes);
			});
			// `error` and `close` are one outcome here: the socket is gone and the
			// only response is to redial. Browsers fire `error` before `close` on a
			// failed dial, so scheduling from `close` alone would miss nothing and
			// scheduling from both would double-dial.
			next.addEventListener('close', () => {
				if (socket !== next) return;
				socket = undefined;
				if (isDisposed) return;
				failedAttempts += 1;
				if (!settled) {
					settled = true;
					// The first dial is the one a caller is awaiting. Failing it here
					// rather than silently retrying is what keeps law 7 honest: the
					// opener resolves only once a carrier is actually established.
					if (isInitial) {
						reject(
							new Error(
								'Desktop Epicenter could not open its observation carrier',
							),
						);
						return;
					}
					resolve();
				}
				scheduleReconnect();
			});
			next.addEventListener('error', () => {
				// Left to `close`, which always follows. Registered so a browser
				// does not report an unhandled socket error.
			});
		});
	}

	function scheduleReconnect(): void {
		if (isDisposed || reconnectTimer !== undefined) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			if (isDisposed) return;
			void connectObservation({ isInitial: false }).catch((cause) => {
				log.error(
					new Error('Desktop Epicenter observation redial failed', { cause }),
				);
			});
		}, reconnectDelayMs(Math.max(failedAttempts, 1)));
	}

	// Order matters, and it is the whole of law 7. The carrier is established
	// before this opener resolves, so by the time an app holds a handle it can
	// subscribe and then read with nothing able to land in between. That is what
	// buys the right to promise no initial fire: there is no gap to cover.
	await request<void>({ kind: 'open' });
	await connectObservation({ isInitial: true });

	function bind<
		const TTables extends TableDefinitions,
		const TValues extends ValueDefinitions,
	>(lens: Lens<TTables, TValues>): BoundData<TTables, TValues> {
		requireOpen();
		return Object.freeze({
			tables: Object.freeze(
				Object.fromEntries(
					Object.entries(lens.tables).map(([table, definition]) => [
						table,
						createTableLens(lens.namespace, table, definition),
					]),
				),
			),
			values: Object.freeze(
				Object.fromEntries(
					Object.entries(lens.values).map(([value, definition]) => [
						value,
						createValueLens(lens.namespace, value, definition),
					]),
				),
			),
		}) as BoundData<TTables, TValues>;
	}

	function createTableLens<TDefinition extends TableDefinition>(
		namespace: string,
		table: string,
		definition: TDefinition,
	): TableLens<TDefinition> {
		const serialized = serializeTableDefinition(namespace, table, definition);
		const readEntriesPage = (after?: string) =>
			request<TableEntriesPage<TDefinition>>({
				kind: 'table-entries-page',
				definition: serialized,
				...(after === undefined ? {} : { after }),
			});
		const lens = {
			create(fields: CreateInputFor<TDefinition>) {
				return request<RowFor<TDefinition>>({
					kind: 'table-create',
					definition: serialized,
					fields,
				});
			},
			get(rowId: string) {
				const address = rowAddress(namespace, table, rowId);
				return request<Awaited<ReturnType<TableLens<TDefinition>['get']>>>({
					kind: 'table-get',
					definition: serialized,
					address,
				});
			},
			update<const TChanges extends Record<string, unknown>>(
				rowId: string,
				patch: TChanges & ConstrainedUpdate<TDefinition, TChanges>,
			) {
				const address = rowAddress(namespace, table, rowId);
				return request<Awaited<ReturnType<TableLens<TDefinition>['update']>>>({
					kind: 'table-update',
					definition: serialized,
					address,
					patch,
				});
			},
			delete(rowId: string) {
				const address = rowAddress(namespace, table, rowId);
				return request<boolean>({
					kind: 'table-delete',
					definition: serialized,
					address,
				});
			},
			...createTableReadMethods(readEntriesPage),
			subscribe(listener: (invalidation: TableInvalidation) => void) {
				requireOpen();
				return observation.subscribeTable(namespace, table, listener);
			},
			openDocument: (rowId: string) => openDocument(serialized, rowId),
		};
		return Object.freeze(lens) as TableLens<TDefinition>;
	}

	function createValueLens<TDefinition extends ValueDefinition>(
		namespace: string,
		valueName: string,
		definition: TDefinition,
	): ValueLens<TDefinition> {
		const address: ValueAddress = {
			kind: 'value',
			namespace,
			valueName: valueName,
		};
		const serialized = serializeValueDefinition(address, definition);
		return Object.freeze({
			get: () =>
				request<Awaited<ReturnType<ValueLens<TDefinition>['get']>>>({
					kind: 'value-get',
					definition: serialized,
					address,
				}),
			set(value: ValueFor<TDefinition>) {
				return request<void>({
					kind: 'value-set',
					definition: serialized,
					address,
					value: value as JsonValue,
				});
			},
			unset() {
				return request<void>({
					kind: 'value-unset',
					definition: serialized,
					address,
				});
			},
			subscribe(listener: () => void) {
				requireOpen();
				return observation.subscribeValue(address, listener);
			},
		});
	}

	async function openDocument(
		definition: SerializedTableDefinition,
		rowId: string,
	): Promise<RowDocument> {
		const opened = await request<{ documentId: number; update: string }>({
			kind: 'document-open',
			definition,
			address: rowAddress(definition.namespace, definition.table, rowId),
		});
		const document = new Y.Doc({ gc: true });
		let disposed = false;
		let persistenceTail = Promise.resolve();
		let refreshFailure: unknown;
		let refreshTimer: ReturnType<typeof setTimeout> | undefined;
		const refresh = async () => {
			try {
				const update = await request<string>({
					kind: 'document-refresh',
					documentId: opened.documentId,
				});
				if (!disposed) {
					Y.applyUpdateV2(document, decodeBytes(update), remoteDocumentOrigin);
				}
			} catch (cause) {
				refreshFailure = cause;
			} finally {
				if (!disposed && !isDisposed) {
					refreshTimer = setTimeout(() => void refresh(), 500);
				}
			}
		};
		let persistFailure: Error | undefined;
		const persist = (update: Uint8Array, origin: unknown) => {
			if (origin === remoteDocumentOrigin) return;
			persistenceTail = persistenceTail.then(() =>
				request<void>({
					kind: 'document-update',
					documentId: opened.documentId,
					update: encodeBytes(update),
				}).catch((cause) => {
					// Fail closed: once the owner has missed an edit, later edits
					// would silently diverge from durable state.
					persistFailure ??= new Error(
						'Row document persistence failed; the handle is closed to protect durable state',
						{ cause },
					);
				}),
			);
		};
		document.on('updateV2', persist);
		Y.applyUpdateV2(document, decodeBytes(opened.update), remoteDocumentOrigin);
		refreshTimer = setTimeout(() => void refresh(), 500);

		const handle: RowDocument = {
			get: document.get.bind(document),
			transact: document.transact.bind(document),
			async whenDurable() {
				await persistenceTail;
				if (persistFailure !== undefined) throw persistFailure;
				if (refreshFailure !== undefined) throw refreshFailure;
			},
			async pull() {
				// The Bun owner runs the pull: overlap safety, the version cache,
				// and the accepted-origin apply all live with the owner document.
				await persistenceTail;
				if (persistFailure !== undefined) throw persistFailure;
				return request<Awaited<ReturnType<RowDocument['pull']>>>({
					kind: 'document-pull',
					documentId: opened.documentId,
				});
			},
			async syncIssue() {
				return request<Awaited<ReturnType<RowDocument['syncIssue']>>>({
					kind: 'document-issue',
					documentId: opened.documentId,
				});
			},
			async [Symbol.asyncDispose]() {
				if (disposed) return;
				disposed = true;
				documents.delete(handle);
				clearTimeout(refreshTimer);
				document.off('updateV2', persist);
				await persistenceTail;
				if (!isDisposed) {
					await request<void>({
						kind: 'document-close',
						documentId: opened.documentId,
					});
				}
				document.destroy();
			},
		};
		registerRowDocumentConnectionTarget(handle, {
			address: rowAddress(definition.namespace, definition.table, rowId),
			applyUpdate(update, origin) {
				Y.applyUpdateV2(document, update, origin);
			},
			encodeStateAsUpdate: () =>
				new Uint8Array(Y.encodeStateAsUpdateV2(document)),
			observe(listener) {
				document.on('updateV2', listener);
				return () => document.off('updateV2', listener);
			},
		});
		documents.add(handle);
		return handle;
	}

	return Object.freeze({
		bind,
		async attachSync() {
			throw new Error('Desktop synchronization is owned by the Bun host');
		},
		get syncStatus() {
			return { state: 'local' as const, lastError: undefined };
		},
		subscribeSyncStatus() {
			return () => undefined;
		},
		async [Symbol.asyncDispose]() {
			if (isDisposed) return;
			for (const document of [...documents]) {
				await document[Symbol.asyncDispose]();
			}
			await request<void>({ kind: 'disconnect' });
			isDisposed = true;
			clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
			socket?.close();
			socket = undefined;
			observation.clear();
		},
	});
}

function defaultOrigin(): string {
	const location = (globalThis as { location?: { origin?: unknown } }).location;
	if (typeof location?.origin !== 'string') {
		throw new Error('Desktop Epicenter requires an explicit baseUrl');
	}
	return location.origin;
}

function serializeTableDefinition(
	namespace: string,
	table: string,
	definition: TableDefinition,
): SerializedTableDefinition {
	const compiled = compileTableDefinition(definition);
	return {
		namespace,
		table,
		fields: cloneJson(definition.fields),
		optionalFields: [...compiled.optional],
	};
}

function serializeValueDefinition(
	address: ValueAddress,
	definition: ValueDefinition,
): SerializedValueDefinition {
	compileValueDefinition(definition);
	return { address, value: cloneJson(definition.value) };
}

function rowAddress(
	namespace: string,
	tableName: string,
	rowId: string,
): RowAddress {
	return { kind: 'row', namespace, tableName, rowId };
}

function cloneJson<TValue>(value: TValue): TValue {
	return JSON.parse(JSON.stringify(value)) as TValue;
}

function decodeBytes(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBytes(value: Uint8Array): string {
	let binary = '';
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/**
 * Read one carrier frame, or nothing when the host said something this client
 * does not recognize. An unreadable frame is dropped rather than thrown: the
 * carrier's job is liveness, and killing the socket over one bad message would
 * turn a cosmetic mismatch into a surface that stops updating.
 */
function parseInvalidationFrame(
	data: unknown,
): DesktopInvalidationFrame | undefined {
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
		return parsed as DesktopInvalidationFrame;
	} catch {
		return undefined;
	}
}

function defaultObservationSocket(url: string): ObservationSocket {
	if (typeof WebSocket === 'undefined') {
		throw new Error(
			'Desktop Epicenter requires WebSocket for live data observation',
		);
	}
	return new WebSocket(url);
}

export type {
	DesktopInvalidationFrame,
	DesktopRequest,
	DesktopResponse,
} from './desktop-protocol.js';
export {
	DESKTOP_EPICENTER_OBSERVE_ROUTE,
	DESKTOP_EPICENTER_ROUTE,
} from './desktop-protocol.js';
