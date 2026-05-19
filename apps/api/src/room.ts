/**
 * Self-contained Yjs sync + dispatch room for Cloudflare Durable Objects.
 *
 * Everything a room needs lives in this file: SQLite update log persistence,
 * WebSocket lifecycle, awareness liveness tracking, dispatch correlation,
 * and the `Room` class itself.
 *
 * ## Module structure
 *
 * {@link Room}: the Durable Object class wiring persistence, sync, awareness,
 *   and dispatch together.
 *
 * ## Wire surfaces
 *
 * Three surfaces share auth context but are independent at the wire level:
 *
 *   binary WS frames  -> standard y-protocols (SYNC + AWARENESS).
 *   text WS frames    -> dispatch push/response: server -> recipient
 *                        `dispatch_inbound`, recipient -> server
 *                        `dispatch_response`.
 *   RPC method        -> {@link Room.dispatch}: the Worker forwards
 *                        `POST /rooms/:room/dispatch` here. The DO mints
 *                        a correlation id, pushes `dispatch_inbound` to
 *                        the recipient's socket, and resolves the RPC
 *                        promise when the recipient's `dispatch_response`
 *                        arrives.
 *
 * ## Liveness
 *
 * Liveness is published as a Yjs awareness `liveness.installationId`
 * field. The relay validates every inbound awareness update against the
 * URL-stamped `installationId` and force-clears the peer's state on
 * socket close. There is no durable presence row.
 */

import { DurableObject } from 'cloudflare:workers';
import {
	decodeSyncRequest,
	encodeSyncStep1,
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
	stateVectorsEqual,
} from '@epicenter/sync';
import * as Y from 'yjs';
import {
	Awareness,
	removeAwarenessStates,
} from 'y-protocols/awareness';
import { MAX_PAYLOAD_BYTES } from './constants';
import {
	applyMessage,
	type Connection,
	encodeAwarenessFrameForClients,
	type RoomContext,
	registerConnection,
} from './sync-handlers';

// ============================================================================
// Dispatch wire types (text frames + RPC)
// ============================================================================

/**
 * Server -> recipient text frame. Pushed by the DO when an HTTP dispatch
 * call resolves a live socket for `to`. The recipient runs the action and
 * replies with `dispatch_response` carrying the same `id`.
 */
type DispatchInboundFrame = {
	type: 'dispatch_inbound';
	id: string;
	from: string;
	action: string;
	input: unknown;
};

/** Wire form of a `Result<unknown, DispatchError>`. */
export type DispatchResult =
	| { data: unknown }
	| { error: DispatchErrorWire };

export type DispatchErrorWire =
	| { name: 'RecipientOffline'; to: string; message: string }
	| { name: 'ActionNotFound'; action: string; message: string }
	| {
			name: 'ActionFailed';
			action: string;
			cause: string;
			message: string;
	  };

export type DispatchRpcRequest = {
	from: string;
	to: string;
	action: string;
	input?: unknown;
};

// ============================================================================
// Constants
// ============================================================================

/**
 * Max compacted update size (2 MB). Cloudflare DO SQLite enforces a hard
 * 2 MB per-row BLOB limit.
 */
const MAX_COMPACTED_BYTES = 2 * 1024 * 1024;

/** Delay before alarm-based compaction fires (30 seconds). */
const COMPACTION_DELAY_MS = 30_000;

/**
 * Internal cap on how long the DO holds an in-flight dispatch open before
 * giving up on the recipient. The HTTP request's lifetime is the actual
 * deadline (the caller's `AbortSignal` or fetch timeout); this is a safety
 * net so the pending map cannot grow unbounded if both the recipient and
 * the caller misbehave.
 *
 * Set well under Cloudflare Workers' HTTP request timeout (~100s) so the
 * `RecipientOffline` response always rides the original request.
 */
const DISPATCH_INTERNAL_TIMEOUT_MS = 60_000;

/**
 * Per-connection metadata persisted via `ws.serializeAttachment` to survive
 * hibernation.
 *
 * - `installationId`: URL-stamped at upgrade, the address used by dispatch.
 * - `clientID`: the Yjs awareness `clientID` for this peer, learned from
 *   the first inbound awareness update. Needed by `removeAwarenessStates`
 *   on close so peers see the liveness drop within one RTT.
 *
 * The added `clientID` keeps the attachment well under the 2 KB budget.
 */
type WsAttachment = {
	installationId: string;
	clientID?: number;
};

// ============================================================================
// Room
// ============================================================================

/**
 * Yjs sync + dispatch room backed by a Cloudflare Durable Object.
 *
 * Owns: SQLite update log persistence, WebSocket lifecycle via the
 * Hibernation API, HTTP sync via RPC, dispatch correlation, and the
 * shared `Awareness` instance for device liveness. Every room runs with
 * `gc: true`.
 *
 * ## Worker to DO interface
 *
 * **RPC** (`stub.sync()`, `stub.getDoc()`, `stub.dispatch()`): for HTTP
 *   sync, snapshot bootstrap, and the HTTP `POST /rooms/:room/dispatch`
 *   endpoint. Direct method calls avoid Request/Response serialization
 *   overhead for binary payloads.
 * **fetch** (`stub.fetch(request)`): for WebSocket upgrades only, since
 *   the 101 Switching Protocols handshake requires HTTP request/response
 *   semantics.
 *
 * ## Storage model
 *
 * Append-only update log in DO SQLite with opportunistic cold-start
 * compaction. Initialized inside `blockConcurrencyWhile` in the constructor.
 *
 * ## Auth & data isolation
 *
 * Handled upstream by `requireOAuthUser` in app.ts. The Worker validates
 * the session (cookie, or `bearer.<token>` subprotocol for WebSocket) via
 * Better Auth before calling RPC methods or forwarding fetch. The DO
 * itself does not re-validate (it trusts the Worker boundary).
 *
 * DO names are subject-scoped: the Worker constructs
 * `subject:{subject}:rooms:{room}` before calling `idFromName()`. This
 * ensures each owner's data is isolated in separate DO instances. The
 * relay treats `from` on a dispatch as a routing label within the
 * authenticated subject, not as a cross-subject auth principal.
 */
export class Room extends DurableObject {
	/**
	 * The shared Yjs document for this room.
	 *
	 * Initialized inside `ctx.blockConcurrencyWhile()` in the constructor.
	 * The definite assignment assertion (`!`) is safe because of two
	 * guarantees working together:
	 *
	 * 1. **Cloudflare runtime guarantee**: `blockConcurrencyWhile` prevents
	 *    the DO from receiving any incoming requests until the
	 *    initialization promise resolves.
	 * 2. **Synchronous async callback**: The callback passed to
	 *    `blockConcurrencyWhile` contains no `await`, so it executes to
	 *    completion synchronously.
	 *
	 * If an `await` is ever added to the `blockConcurrencyWhile` callback,
	 * guarantee (2) breaks.
	 *
	 * @see {@link https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile | blockConcurrencyWhile docs}
	 */
	private doc!: Y.Doc;

	/** Shared awareness, holds every connected peer's `liveness.installationId`. */
	private awareness!: Awareness;

	/** Shared room state forwarded into sync handlers. */
	private room!: RoomContext;

	/** Active WebSocket connections and their per-connection sync state. */
	private connections = new Map<WebSocket, Connection>();

	/**
	 * In-flight dispatches awaiting `dispatch_response`. Keyed by the
	 * server-minted correlation id. Each entry captures the recipient
	 * socket (for "did this close mid-flight?" cleanup) and a `resolve`
	 * that completes the awaiting RPC promise. `resolve`'s closure also
	 * clears the safety timeout, so the rest of the DO never has to
	 * touch the timer directly.
	 */
	private pendingDispatches = new Map<
		string,
		{
			recipientWs: WebSocket;
			resolve: (result: DispatchResult) => void;
		}
	>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('ping', 'pong'),
		);

		ctx.blockConcurrencyWhile(async () => {
			this.doc = new Y.Doc({ gc: true });
			this.awareness = new Awareness(this.doc);
			// The y-protocols `Awareness` constructor publishes an implicit
			// empty `{}` self-state on the doc's clientID. The relay never
			// participates in dispatch and has no liveness of its own to
			// announce, so we drop that placeholder. The result is that
			// `awareness.getStates()` is exactly "online remote peers".
			this.awareness.setLocalState(null);

			this.room = {
				doc: this.doc,
				awareness: this.awareness,
				subject: subjectFromDoName(ctx.id.name),
			};

			// --- Update log: DDL + cold-start load + compaction + live persist ---

			ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS updates (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					data BLOB NOT NULL
				)
			`);

			const rows = ctx.storage.sql
				.exec('SELECT data FROM updates ORDER BY id')
				.toArray();

			for (const row of rows) {
				Y.applyUpdateV2(this.doc, new Uint8Array(row.data as ArrayBuffer));
			}
			compactUpdateLog(ctx, this.doc);

			this.doc.on('updateV2', (update: Uint8Array) => {
				ctx.storage.sql.exec('INSERT INTO updates (data) VALUES (?)', update);
			});

			// --- Restore connections that survived hibernation ---
			// Iterates ctx.getWebSockets(), reads the URL-stamped installationId
			// and the awareness clientID (if learned before hibernation) from
			// each attachment, and re-registers sync handlers.
			//
			// For sockets whose attachment carries a clientID we also restore
			// liveness state programmatically so `awareness.getStates()` is
			// non-empty immediately after wake, closing the "picker shows no
			// devices for 15s" race called out in the spec.
			const restoredClientIDs: number[] = [];
			for (const ws of ctx.getWebSockets()) {
				const attachment = ws.deserializeAttachment() as WsAttachment | null;
				if (!attachment) continue;

				const connection = registerConnection({
					doc: this.doc,
					ws,
					installationId: attachment.installationId,
				});
				this.connections.set(ws, connection);

				if (attachment.clientID != null) {
					this.awareness.states.set(attachment.clientID, {
						liveness: { installationId: attachment.installationId },
					});
					// y-protocols compares `outdatedTimeout` (30000) against
					// `Date.now() - lastUpdated`; lib0's `getUnixTime` is `Date.now`
					// (milliseconds). Writing seconds here causes the outlier loop
					// to reap restored liveness within ~100ms of wake.
					this.awareness.meta.set(attachment.clientID, {
						clock: 1,
						lastUpdated: Date.now(),
					});
					restoredClientIDs.push(attachment.clientID);
				}
			}

			// Broadcast restored liveness so peers don't have to wait for the
			// next 15s awareness heartbeat to refresh their view.
			if (restoredClientIDs.length > 0) {
				const frame = encodeAwarenessFrameForClients(
					this.awareness,
					restoredClientIDs,
				);
				for (const [ws] of this.connections) {
					try {
						ws.send(frame);
					} catch {
						// Socket may already be in a bad state after wake. The
						// next inbound message will trigger close-time cleanup.
					}
				}
			}
		});
	}

	// --- fetch: WebSocket upgrades only ---

	/**
	 * Only handles WebSocket upgrades. HTTP sync operations are exposed
	 * as RPC methods called directly on the stub, avoiding the overhead
	 * of constructing/parsing Request/Response objects for binary payloads.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') === 'websocket') {
			return this.upgrade(request);
		}
		return new Response('Method not allowed', { status: 405 });
	}

	/**
	 * Accept a WebSocket upgrade via the Hibernation API.
	 *
	 * Creates a `WebSocketPair`, registers the server side with the Cloudflare
	 * runtime for hibernation, stashes the URL-stamped `installationId` in
	 * the attachment, runs the initial Yjs sync handshake (SyncStep1), and
	 * returns the 101 Switching Protocols response.
	 *
	 * The `installationId` query parameter is required: it is the address
	 * used by `dispatch({ to })` and the value the relay enforces on every
	 * inbound awareness update via the liveness validation hook.
	 *
	 * Cancels any pending compaction alarm: a new client just connected, so
	 * compacting now would be wasteful.
	 *
	 * The client offers `sec-websocket-protocol: <MAIN_SUBPROTOCOL>, bearer.<token>`;
	 * we echo only the main subprotocol to complete the handshake.
	 */
	private upgrade(request: Request): Response {
		const url = new URL(request.url);
		const installationId = url.searchParams.get('installationId');
		if (!installationId) {
			return new Response('missing installationId', { status: 400 });
		}

		void this.ctx.storage.deleteAlarm();

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];

		this.ctx.acceptWebSocket(server);

		server.serializeAttachment({ installationId } satisfies WsAttachment);

		const connection = registerConnection({
			doc: this.doc,
			ws: server,
			installationId,
		});
		this.connections.set(server, connection);

		server.send(encodeSyncStep1({ doc: this.doc }));

		const responseHeaders = new Headers();
		const offered = parseSubprotocols(
			request.headers.get('sec-websocket-protocol'),
		);
		if (offered.includes(MAIN_SUBPROTOCOL)) {
			responseHeaders.set('sec-websocket-protocol', MAIN_SUBPROTOCOL);
		}

		return new Response(null, {
			status: 101,
			webSocket: client,
			headers: responseHeaders,
		});
	}

	// --- RPC methods (called via stub.sync() / stub.getDoc() / stub.dispatch()) ---

	/**
	 * HTTP sync via RPC.
	 *
	 * Binary body format: `[length-prefixed stateVector][length-prefixed update]`
	 * (encoded via `encodeSyncRequest` from sync-core).
	 *
	 * Applies the client update to the live doc and returns the binary
	 * diff the client is missing, or `null` if already in sync.
	 */
	async sync(
		body: Uint8Array,
	): Promise<{ diff: Uint8Array | null; storageBytes: number }> {
		const { stateVector: clientSV, update } = decodeSyncRequest(body);

		if (update.byteLength > 0) {
			Y.applyUpdateV2(this.doc, update, 'http');
		}

		const serverSV = Y.encodeStateVector(this.doc);
		const diff = stateVectorsEqual(serverSV, clientSV)
			? null
			: Y.encodeStateAsUpdateV2(this.doc, clientSV);

		return { diff, storageBytes: this.ctx.storage.sql.databaseSize };
	}

	/**
	 * Snapshot bootstrap via RPC.
	 *
	 * Returns the full doc state via `Y.encodeStateAsUpdateV2`. Clients
	 * apply this with `Y.applyUpdateV2` to hydrate their local doc before
	 * opening a WebSocket, reducing the initial sync payload size.
	 */
	async getDoc(): Promise<{ data: Uint8Array; storageBytes: number }> {
		return {
			data: Y.encodeStateAsUpdateV2(this.doc),
			storageBytes: this.ctx.storage.sql.databaseSize,
		};
	}

	/** Delete all storage for this DO. Used for cleanup of renamed/orphaned rooms. */
	async deleteStorage(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}

	/**
	 * Dispatch RPC: route an HTTP `POST /rooms/:room/dispatch` body to a
	 * live recipient socket, await its response, and return the result.
	 *
	 * Picks the most-recently-connected socket for `to`. On miss returns
	 * `RecipientOffline` immediately. Otherwise mints a correlation id,
	 * pushes `dispatch_inbound` to the recipient, and resolves the
	 * Promise either:
	 *   - on matching `dispatch_response`,
	 *   - on the recipient socket closing (the relay observes the close
	 *     and resolves pending entries with `RecipientOffline`),
	 *   - on the internal safety-net timeout firing (`RecipientOffline`).
	 *
	 * The caller's HTTP request lifetime is the *real* deadline. If the
	 * caller aborts, the DO's Promise resolution is discarded by the
	 * Worker; the internal timeout cleans up the pending entry.
	 */
	async dispatch(req: DispatchRpcRequest): Promise<DispatchResult> {
		const recipientWs = this.pickRecipient(req.to);
		if (!recipientWs) {
			return {
				error: {
					name: 'RecipientOffline',
					to: req.to,
					message: `Recipient "${req.to}" is offline`,
				},
			};
		}

		const id = crypto.randomUUID();
		const frame: DispatchInboundFrame = {
			type: 'dispatch_inbound',
			id,
			from: req.from,
			action: req.action,
			input: req.input,
		};

		return new Promise<DispatchResult>((resolve) => {
			const timeoutHandle = setTimeout(() => {
				if (!this.pendingDispatches.has(id)) return;
				this.pendingDispatches.delete(id);
				resolve({
					error: {
						name: 'RecipientOffline',
						to: req.to,
						message: `Recipient "${req.to}" is offline`,
					},
				});
			}, DISPATCH_INTERNAL_TIMEOUT_MS);

			this.pendingDispatches.set(id, {
				recipientWs,
				resolve: (result) => {
					clearTimeout(timeoutHandle);
					resolve(result);
				},
			});

			try {
				recipientWs.send(JSON.stringify(frame));
			} catch {
				// Socket died between pickRecipient and send. Route through the
				// pending entry's `resolve` so the safety timeout is cleared.
				const pending = this.pendingDispatches.get(id);
				if (pending) {
					this.pendingDispatches.delete(id);
					pending.resolve({
						error: {
							name: 'RecipientOffline',
							to: req.to,
							message: `Recipient "${req.to}" is offline`,
						},
					});
				}
			}
		});
	}

	/**
	 * Resolve a recipient `installationId` to the most-recently-connected
	 * open socket, if any. Iteration order in `Map` is insertion order, so
	 * the *last* match in a forward scan is the newest.
	 */
	private pickRecipient(installationId: string): WebSocket | null {
		let newest: WebSocket | null = null;
		for (const [ws, connection] of this.connections) {
			if (
				connection.installationId === installationId &&
				ws.readyState === WebSocket.OPEN
			) {
				newest = ws;
			}
		}
		return newest;
	}

	// --- WebSocket lifecycle ---

	/**
	 * Handle an incoming WebSocket message.
	 *
	 * Routes on the message envelope:
	 *   - text frames: dispatch_response correlation.
	 *   - binary frames: standard y-protocols SYNC / AWARENESS / AUTH.
	 *
	 * For AWARENESS, captures the surviving `clientID` so a later close
	 * can call `removeAwarenessStates` for that specific peer. Updates
	 * the WS attachment in place; the added field stays inside the 2 KB
	 * attachment budget.
	 */
	override async webSocketMessage(
		ws: WebSocket,
		message: ArrayBuffer | string,
	): Promise<void> {
		const connection = this.connections.get(ws);
		if (!connection) return;

		const byteLength =
			message instanceof ArrayBuffer ? message.byteLength : message.length;
		if (byteLength > MAX_PAYLOAD_BYTES) {
			ws.close(1009, 'Message too large');
			return;
		}

		if (typeof message === 'string') {
			this.handleTextFrame(ws, connection, message);
			return;
		}

		const { data: effect, error } = applyMessage({
			data: new Uint8Array(message),
			room: this.room,
			connection,
		});
		if (error) {
			console.error(error.message);
			return;
		}
		if (!effect) return;

		if (effect.action === 'reply') {
			ws.send(effect.data);
			return;
		}
		// broadcast
		if (effect.learnedClientIDs?.length) {
			this.maybeRecordClientID(ws, connection, effect.learnedClientIDs[0]!);
		}
		this.broadcast(ws, effect.data);
	}

	/**
	 * Handle a recipient -> server text frame. Today the only valid type
	 * is `dispatch_response`; anything else closes the socket with
	 * `4400 protocol-error`.
	 */
	private handleTextFrame(
		ws: WebSocket,
		connection: Connection,
		message: string,
	): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(message);
		} catch {
			ws.close(4400, 'protocol-error');
			return;
		}

		if (
			!parsed ||
			typeof parsed !== 'object' ||
			!('type' in parsed) ||
			typeof (parsed as { type: unknown }).type !== 'string'
		) {
			ws.close(4400, 'protocol-error');
			return;
		}

		const frame = parsed as { type: string; id?: unknown; result?: unknown };
		if (frame.type !== 'dispatch_response') {
			ws.close(4400, 'protocol-error');
			return;
		}

		const id = typeof frame.id === 'string' ? frame.id : null;
		if (!id) return;

		const pending = this.pendingDispatches.get(id);
		if (!pending) return; // late response, HTTP request already gone

		const result = frame.result as DispatchResult | undefined;
		if (!isDispatchResult(result)) {
			// Recipient sent a malformed result; treat as offline so the caller
			// gets a usable Result rather than hanging until the safety timeout.
			this.pendingDispatches.delete(id);
			pending.resolve({
				error: {
					name: 'RecipientOffline',
					to: connection.installationId,
					message: 'Recipient returned a malformed dispatch response',
				},
			});
			return;
		}

		this.pendingDispatches.delete(id);
		pending.resolve(result);
	}

	/**
	 * Fan out a frame to every connection other than `origin`. Silently
	 * swallows per-socket send failures: if a peer just died, the close
	 * event will fire and trigger the full cleanup path.
	 */
	private broadcast(origin: WebSocket, data: Uint8Array | string): void {
		for (const [peer] of this.connections) {
			if (peer === origin) continue;
			if (peer.readyState !== WebSocket.OPEN) continue;
			try {
				peer.send(data);
			} catch {
				/* see comment above */
			}
		}
	}

	/**
	 * Record a learned awareness `clientID` into the WS attachment so
	 * `webSocketClose` can call `removeAwarenessStates(awareness, [clientID])`
	 * for an immediate force-clear (no 30s heartbeat timeout). Subsequent
	 * awareness updates from the same socket may also pass through here;
	 * the no-op branch keeps the write count to one.
	 */
	private maybeRecordClientID(
		ws: WebSocket,
		connection: Connection,
		clientID: number,
	): void {
		const attachment = ws.deserializeAttachment() as WsAttachment | null;
		if (!attachment) return;
		if (attachment.clientID === clientID) return;
		ws.serializeAttachment({
			installationId: connection.installationId,
			clientID,
		} satisfies WsAttachment);
	}

	/**
	 * Clean up a closed WebSocket connection.
	 *
	 * - Force-clears the peer's awareness liveness state (broadcasts a
	 *   null state so peers see the device drop within one RTT).
	 * - Resolves any in-flight dispatches to this recipient with
	 *   `RecipientOffline` so callers don't wait for the safety timeout.
	 * - Unregisters Yjs doc update handlers.
	 * - Schedules deferred compaction if the last socket just left.
	 */
	override async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		const connection = this.connections.get(ws);
		if (!connection) return;

		const attachment = ws.deserializeAttachment() as WsAttachment | null;
		if (attachment?.clientID != null) {
			removeAwarenessStates(this.awareness, [attachment.clientID], 'close');
			this.broadcast(
				ws,
				encodeAwarenessFrameForClients(this.awareness, [attachment.clientID]),
			);
		}

		// Fail any in-flight dispatches that were waiting on this socket.
		// `pending.resolve` clears the safety timeout via its closure, so we
		// only need to delete the map entry and call resolve here.
		for (const [id, pending] of this.pendingDispatches) {
			if (pending.recipientWs !== ws) continue;
			this.pendingDispatches.delete(id);
			pending.resolve({
				error: {
					name: 'RecipientOffline',
					to: connection.installationId,
					message: `Recipient "${connection.installationId}" is offline`,
				},
			});
		}

		connection.unregister();
		this.connections.delete(ws);

		try {
			ws.close(code, reason);
		} catch {
			/* already closed by the remote end */
		}

		if (this.connections.size === 0) {
			void this.ctx.storage.setAlarm(Date.now() + COMPACTION_DELAY_MS);
		}
	}

	/**
	 * Handle a WebSocket error by closing with status 1011 (Internal Error).
	 * Delegates to {@link webSocketClose} so the same cleanup path runs
	 * regardless of whether the socket closed cleanly or errored.
	 */
	override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		await this.webSocketClose(ws, 1011, 'WebSocket error', false);
	}

	// --- Alarm: deferred compaction ---

	/**
	 * Compact the update log after all clients disconnect.
	 *
	 * Scheduled 30s after the last WebSocket closes via `ctx.storage.setAlarm`.
	 * Cancelled if a client reconnects before the alarm fires (see `upgrade()`).
	 *
	 * @see {@link https://developers.cloudflare.com/durable-objects/api/alarms/ | Durable Objects Alarms}
	 */
	override async alarm(): Promise<void> {
		if (this.connections.size > 0) return;
		compactUpdateLog(this.ctx, this.doc);
	}
}

// ============================================================================
// Subject parser
// ============================================================================

/**
 * Extract the owning subject from the DO name.
 *
 * DO names are formatted by `getRoomStub` in app.ts as
 * `subject:{subject}:rooms:{room}`. Every connection to this DO shares the
 * same auth context, so `subject` is room-scoped, not connection-scoped.
 *
 * Throws on an unrecognized shape so misconfigured deployments fail loudly
 * at boot rather than silently mishandling subject scope.
 */
function subjectFromDoName(name: string | undefined): string {
	const match = name?.match(/^subject:([^:]+):/);
	if (!match) {
		throw new Error(
			`[room] DO name does not match expected ` +
				`"subject:{subject}:rooms:{room}" format: ${JSON.stringify(name)}`,
		);
	}
	return match[1] as string;
}

// ============================================================================
// Dispatch wire validators
// ============================================================================

/** Structural check that `value` is a wire-shaped `DispatchResult`. */
function isDispatchResult(value: unknown): value is DispatchResult {
	if (!value || typeof value !== 'object') return false;
	const hasData = 'data' in value;
	const hasError = 'error' in value;
	if (hasData && hasError) return false;
	if (!hasData && !hasError) return false;
	return true;
}

// ============================================================================
// compactUpdateLog
// ============================================================================

/**
 * Compact the SQLite update log into a single row.
 *
 * Encodes the current doc state via `Y.encodeStateAsUpdateV2`: produces
 * smaller output than `Y.mergeUpdatesV2` because deleted items become
 * lightweight GC structs (with `gc: true`) and struct merging is more
 * thorough. Also avoids the exponential performance edge case documented
 * in yjs#710.
 *
 * No-ops if the log already has <= 1 row or the compacted blob exceeds
 * the 2 MB per-row BLOB limit.
 *
 * @see {@link https://github.com/yjs/yjs/issues/710 | yjs#710 mergeUpdatesV2 performance}
 */
function compactUpdateLog(ctx: DurableObjectState, doc: Y.Doc): void {
	const rowCount = ctx.storage.sql
		.exec('SELECT COUNT(*) as count FROM updates')
		.one().count as number;
	if (rowCount <= 1) return;

	const compacted = Y.encodeStateAsUpdateV2(doc);
	if (compacted.byteLength > MAX_COMPACTED_BYTES) return;

	ctx.storage.transactionSync(() => {
		ctx.storage.sql.exec('DELETE FROM updates');
		ctx.storage.sql.exec('INSERT INTO updates (data) VALUES (?)', compacted);
	});

	console.log(`[compaction] ${rowCount} rows to ${compacted.byteLength} bytes`);
}
