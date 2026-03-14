/**
 * Self-contained Yjs sync room for Cloudflare Durable Objects.
 *
 * Everything a sync room needs lives in this file: SQLite persistence,
 * WebSocket lifecycle, connection management, and the abstract base class.
 * The only external dependency is `sync-handlers.ts` for the Yjs wire
 * protocol (encode/decode/dispatch). Subclasses (`WorkspaceRoom`,
 * `DocumentRoom`) import from here and nowhere else.
 *
 * ## Module structure
 *
 * - {@link BaseSyncRoom} — DO base class wiring persistence + connections together
 */

import { DurableObject } from 'cloudflare:workers';
import { decodeSyncRequest, stateVectorsEqual } from '@epicenter/sync';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { MAX_PAYLOAD_BYTES } from './constants';
import {
	applyMessage,
	type Connection,
	computeInitialMessages,
	type RoomContext,
	registerConnection,
	teardownConnection,
} from './sync-handlers';

// ============================================================================
// SyncRoomConfig
// ============================================================================

/**
 * Configuration for customizing sync room behavior.
 *
 * Passed to the {@link BaseSyncRoom} constructor. Keeps customization
 * explicit and co-located with the subclass constructor.
 */
type SyncRoomConfig = {
	/**
	 * Whether to enable Yjs garbage collection.
	 *
	 * - `true` — workspace rooms that don't need version history
	 * - `false` — document rooms that preserve delete history so
	 *   `Y.snapshot()` can reconstruct past states
	 */
	gc: boolean;
};

// ============================================================================
// BaseSyncRoom
// ============================================================================

/**
 * Base class for Yjs sync rooms backed by Cloudflare Durable Objects.
 *
 * Owns the shared infrastructure that every sync room needs: SQLite update log
 * persistence, WebSocket lifecycle via the Hibernation API, HTTP sync via RPC,
 * and connection management. Subclasses customize via {@link SyncRoomConfig}:
 *
 * - `gc` — Y.Doc garbage collection via {@link SyncRoomConfig}
 * - {@link BaseSyncRoom.onAllDisconnected} — override to run cleanup when the
 *   last WebSocket client leaves
 *
 * ## Worker → DO interface
 *
 * The Hono Worker in `app.ts` calls into DOs via two mechanisms:
 *
 * - **RPC** (`stub.sync()`, `stub.getDoc()`) — for HTTP sync and snapshot
 *   bootstrap. Direct method calls avoid Request/Response serialization
 *   overhead for binary payloads. The Worker handles HTTP concerns (status
 *   codes, content-type headers); the DO handles only Yjs logic.
 * - **fetch** (`stub.fetch(request)`) — for WebSocket upgrades only, since
 *   the 101 Switching Protocols handshake requires HTTP request/response
 *   semantics. After upgrade, all sync traffic flows through the Hibernation
 *   API callbacks (`webSocketMessage`, `webSocketClose`, `webSocketError`).
 *
 * ## Storage model
 *
 * Append-only update log in DO SQLite with opportunistic cold-start
 * compaction. Initialized inside `blockConcurrencyWhile` in the constructor.
 *
 * ## Auth & data isolation
 *
 * Handled upstream by `authGuard` middleware in app.ts. The Worker validates
 * the session (cookie or `?token=` query param for WebSocket) via Better Auth
 * before calling RPC methods or forwarding fetch. The DO itself does not
 * re-validate — it trusts the Worker boundary.
 *
 * DO names are user-scoped: the Worker constructs
 * `user:{userId}:{type}:{name}` before calling `idFromName()`, where
 * `{type}` is `workspace` or `document`.
 * This ensures each user's data is isolated in separate DO instances, even
 * if multiple users create workspaces with the same name (e.g., "epicenter.tab-manager").
 *
 * We chose user-scoped DO names (Google Docs model) over org-scoped names
 * (Vercel/Supabase model) because most workspaces hold personal data.
 * For enterprise self-hosted, the deployment itself is the org boundary.
 * See `getWorkspaceStub` in app.ts for the full rationale.
 */
export class BaseSyncRoom extends DurableObject {
	/**
	 * The shared Yjs document for this sync room.
	 *
	 * Initialized inside `ctx.blockConcurrencyWhile()` in the constructor.
	 * The definite assignment assertion (`!`) is safe because of two
	 * guarantees working together:
	 *
	 * 1. **Cloudflare runtime guarantee**: `blockConcurrencyWhile` prevents
	 *    the DO from receiving any incoming requests (`fetch`, `webSocketMessage`,
	 *    etc.) until the initialization promise resolves. So no method on this
	 *    class can run before `doc` is set.
	 *
	 * 2. **Synchronous async callback**: The callback passed to
	 *    `blockConcurrencyWhile` contains no `await`, so it executes to
	 *    completion synchronously. This means `doc` is assigned before the
	 *    constructor returns — so subclass constructors (e.g. `DocumentRoom`)
	 *    can safely access `this.doc` after `super()`.
	 *
	 * If an `await` is ever added to the `blockConcurrencyWhile` callback,
	 * guarantee (2) breaks and subclass constructor access becomes unsafe.
	 *
	 * @see {@link https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile | blockConcurrencyWhile docs}
	 */
	protected doc!: Y.Doc;

	/** Shared room state: the Yjs doc and awareness instance all connections share. */
	private room!: RoomContext;

	/** Active WebSocket connections and their per-connection sync state. */
	private connections = new Map<WebSocket, Connection>();

	constructor(ctx: DurableObjectState, env: Env, config: SyncRoomConfig) {
		super(ctx, env);

		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('ping', 'pong'),
		);

		ctx.blockConcurrencyWhile(async () => {
			this.doc = new Y.Doc({ gc: config.gc });
			this.room = { doc: this.doc, awareness: new Awareness(this.doc) };

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
			// Iterates ctx.getWebSockets(), deserializes each attachment to recover
			// controlled awareness client IDs, and re-registers sync handlers.
			// Only registerConnection — no computeInitialMessages (the client
			// already received initial messages before hibernation).
			for (const ws of ctx.getWebSockets()) {
				const attachment = ws.deserializeAttachment() as WsAttachment | null;
				if (!attachment) continue;

				const connection = registerConnection({ ...this.room, ws });
				for (const id of attachment.controlledClientIds) {
					connection.controlledClientIds.add(id);
				}
				this.connections.set(ws, connection);
			}
		});
	}

	// --- fetch: WebSocket upgrades only ---

	/**
	 * Only handles WebSocket upgrades. HTTP operations (sync, snapshot) are
	 * exposed as RPC methods called directly on the stub, avoiding the overhead
	 * of constructing/parsing Request/Response objects for binary payloads.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') === 'websocket') {
			return this.upgrade();
		}
		return new Response('Method not allowed', { status: 405 });
	}

	/**
	 * Accept a WebSocket upgrade via the Hibernation API.
	 *
	 * Creates a `WebSocketPair`, registers the server side with the Cloudflare
	 * runtime for hibernation, runs the initial Yjs sync handshake (SyncStep1 +
	 * current awareness states), and returns the 101 Switching Protocols response.
	 *
	 * Cancels any pending compaction alarm — a new client just connected, so
	 * compacting now would be wasteful.
	 */
	private upgrade(): Response {
		void this.ctx.storage.deleteAlarm();

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];

		this.ctx.acceptWebSocket(server);

		const initialMessages = computeInitialMessages(this.room);
		const connection = registerConnection({ ...this.room, ws: server });
		this.connections.set(server, connection);

		server.serializeAttachment({
			controlledClientIds: [],
		} satisfies WsAttachment);

		for (const msg of initialMessages) {
			server.send(msg);
		}

		return new Response(null, { status: 101, webSocket: client });
	}

	// --- RPC methods (called via stub.sync() / stub.getDoc()) ---

	/**
	 * HTTP sync via RPC.
	 *
	 * Binary body format: `[length-prefixed stateVector][length-prefixed update]`
	 * (encoded via `encodeSyncRequest` from sync-core).
	 *
	 * 1. Applies client update to the live doc (triggers `updateV2` → SQLite
	 *    persist + broadcast to WebSocket peers).
	 * 2. Compares state vectors — returns `null` if already in sync (caller
	 *    maps to 304).
	 * 3. Otherwise returns the binary diff the client is missing.
	 */
	async sync(body: Uint8Array): Promise<{ diff: Uint8Array | null; storageBytes: number }> {
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
	 * Returns the full doc state via `Y.encodeStateAsUpdateV2`. Clients apply
	 * this with `Y.applyUpdateV2` to hydrate their local doc before opening a
	 * WebSocket, reducing the initial sync payload size.
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

	// --- WebSocket lifecycle ---

	/**
	 * Handle an incoming WebSocket message.
	 *
	 * Validates payload size against {@link MAX_PAYLOAD_BYTES}, converts the
	 * raw message to a `Uint8Array`, then delegates to `applyMessage` from
	 * `sync-handlers.ts` for protocol decoding. Checks the returned fields:
	 *
	 * - `response` — send data back to the sender only
	 * - `broadcast` — fan out to all other connected peers
	 * - `persistAttachment` — serialize connection metadata to survive hibernation
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

		const data =
			message instanceof ArrayBuffer
				? new Uint8Array(message)
				: new TextEncoder().encode(message);

		const { data: result, error } = applyMessage({
			data,
			room: this.room,
			connection,
		});
		if (error) {
			console.error(error.message);
			return;
		}

		if (result.response) {
			ws.send(result.response);
		}

		if (result.broadcast) {
			for (const [peer] of this.connections) {
				if (peer !== ws && peer.readyState === WebSocket.OPEN) {
					try {
						peer.send(result.broadcast);
					} catch {
						/* Socket may have died between readyState check and send.
						   Safe to ignore — the close event will fire and trigger
						   proper cleanup via webSocketClose(). */
					}
				}
			}
		}

		if (result.persistAttachment) {
			ws.serializeAttachment({
				controlledClientIds: [...connection.controlledClientIds],
			} satisfies WsAttachment);
		}
	}

	/**
	 * Clean up a closed WebSocket connection.
	 *
	 * Unregisters Yjs doc update and awareness event handlers via
	 * `handleWsClose`, removes the connection from the states map, and
	 * attempts to close the underlying socket (no-op if already closed by
	 * the remote end).
	 *
	 * When the last connection leaves, calls {@link onAllDisconnected} for
	 * subclass cleanup (e.g. auto-saving snapshots in `DocumentRoom`) and
	 * schedules a deferred compaction alarm.
	 */
	override async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		const connection = this.connections.get(ws);
		if (!connection) return;

		teardownConnection({ room: this.room, connection });
		this.connections.delete(ws);

		try {
			ws.close(code, reason);
		} catch {
			/* Already closed by the remote end. Cleanup above (handler
			   deregistration, awareness removal) completed regardless. */
		}

		if (this.connections.size === 0) {
			this.onAllDisconnected();
			void this.ctx.storage.setAlarm(Date.now() + COMPACTION_DELAY_MS);
		}
	}

	/**
	 * Handle a WebSocket error by closing with status 1011 (Internal Error).
	 *
	 * Delegates to {@link webSocketClose} so the same cleanup path
	 * (handler deregistration, awareness removal, compaction scheduling)
	 * runs regardless of whether the socket closed cleanly or errored.
	 */
	override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		await this.webSocketClose(ws, 1011, 'WebSocket error', false);
	}

	/**
	 * Hook called when the last WebSocket client disconnects.
	 *
	 * Override in subclasses to perform cleanup when all clients leave.
	 * For example, `DocumentRoom` overrides this to auto-save a snapshot
	 * if the document changed since the last save.
	 *
	 * Called before the compaction alarm is scheduled. The base
	 * implementation is a no-op.
	 */
	protected onAllDisconnected(): void {}

	// --- Alarm: deferred compaction ---

	/**
	 * Compact the update log after all clients disconnect.
	 *
	 * Scheduled 30s after the last WebSocket closes via `ctx.storage.setAlarm`.
	 * Cancelled if a client reconnects before the alarm fires (see `upgrade()`).
	 *
	 * If the DO is evicted before the alarm fires, the alarm still wakes it —
	 * the constructor re-runs `blockConcurrencyWhile` which does cold-start
	 * compaction, so the alarm handler finds ≤ 1 row and no-ops.
	 *
	 * @see {@link https://developers.cloudflare.com/durable-objects/api/alarms/ | Durable Objects Alarms}
	 */
	override async alarm(): Promise<void> {
		if (this.connections.size > 0) return;
		compactUpdateLog(this.ctx, this.doc);
	}
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Max compacted update size (2 MB). Cloudflare DO SQLite enforces a hard
 * 2 MB per-row BLOB limit.
 *
 * During compaction (cold-start or alarm), the current doc state is encoded
 * via `Y.encodeStateAsUpdateV2`. If the result fits under this limit, all
 * update rows are atomically replaced with a single compacted row. This
 * collapses thousands of tiny keystroke-level updates into one row,
 * dramatically improving future cold-start load times.
 */
const MAX_COMPACTED_BYTES = 2 * 1024 * 1024;

/**
 * Delay before alarm-based compaction fires (30 seconds).
 *
 * Long enough to skip reconnect storms (user refresh, network blip),
 * short enough to fire before DO eviction (~60s idle timeout).
 */
const COMPACTION_DELAY_MS = 30_000;

/** Per-connection metadata persisted via `ws.serializeAttachment` to survive hibernation. */
type WsAttachment = {
	controlledClientIds: number[];
};

// ============================================================================
// compactUpdateLog
// ============================================================================

/**
 * Compact the SQLite update log into a single row.
 *
 * Encodes the current doc state via `Y.encodeStateAsUpdateV2` — produces
 * smaller output than `Y.mergeUpdatesV2` because deleted items become
 * lightweight GC structs (with `gc: true`) and struct merging is more
 * thorough (with `gc: false`). Also avoids the exponential performance
 * edge case documented in yjs#710.
 *
 * No-ops if the log already has ≤ 1 row or the compacted blob exceeds
 * the 2 MB per-row BLOB limit.
 *
 * @see {@link https://github.com/yjs/yjs/issues/710 | yjs#710 — mergeUpdatesV2 performance}
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

	console.log(`[compaction] ${rowCount} rows → ${compacted.byteLength} bytes`);
}
