/**
 * Cloudflare Durable Object adapter for {@link createRoomCore}.
 *
 * The `DurableObject` base class is the one place a class is unavoidable:
 * Cloudflare's runtime instantiates it per room and routes the
 * Hibernation API callbacks (`webSocketMessage`, `webSocketClose`,
 * `webSocketError`, `alarm`) to method overrides. This class is a thin
 * shell: every callback forwards to a single {@link RoomCore} instance
 * built in the constructor.
 *
 * ## Lifecycle
 *
 * 1. **Constructor**: `blockConcurrencyWhile` runs a synchronous init
 *    that builds the {@link RoomUpdateLog} over `ctx.storage`, creates
 *    the `RoomCore`, and re-registers any sockets that survived
 *    hibernation via `ctx.getWebSockets()`.
 * 2. **`fetch`**: only handles WebSocket upgrades; HTTP sync goes via
 *    RPC (`stub.sync()`, `stub.getDoc()`).
 * 3. **Hibernation callbacks**: forward to `core` directly.
 * 4. **`alarm`**: one multiplexed timer. While clients are connected it sweeps
 *    and closes over-age sockets ({@link CONNECTION_SWEEP_INTERVAL_MS}); once
 *    the room empties it compacts 30 s later.
 *
 * ## RoomSocket compatibility
 *
 * Cloudflare's hibernation `WebSocket` exposes `send`, `close`, and
 * `readyState`. TypeScript's structural typing treats it as a
 * {@link RoomSocket}, so the raw socket is passed straight to
 * `core.addConnection` / `core.handleMessage` / `core.removeConnection`
 * with no wrapper.
 */

import { DurableObject } from 'cloudflare:workers';
import { asUserId } from '@epicenter/auth';
import { MAIN_SUBPROTOCOL, parseSubprotocols } from '@epicenter/sync';
import { Ok } from 'wellcrafted/result';
import * as Y from 'yjs';
import type { Connection } from '../../../types.js';
import { createRoomCore, type RoomCore } from '../../core.js';
import {
	createDurableObjectTombstone,
	type DurableObjectTombstone,
} from './tombstone.js';
import { createDurableObjectUpdateLog } from './update-log.js';

/** Delay before alarm-based compaction fires (30 seconds). */
const COMPACTION_DELAY_MS = 30_000;

/**
 * Maximum lifetime of a single WebSocket connection before the server forces
 * a reconnect (30 minutes).
 *
 * Auth is verified once, at the HTTP upgrade, by the rooms route. Without a
 * bound, a socket opened with a valid bearer would keep operating indefinitely
 * even after the access token expires (10min TTL) or the session is revoked.
 * Closing the socket past this age forces the client to reconnect and
 * re-authenticate at a fresh upgrade: a signed-out or revoked client then fails
 * closed, while a healthy client refreshes its token transparently. The bound
 * is intentionally coarser than the access-token TTL to limit reconnect and
 * presence churn; tighten it if a shorter post-revocation window is required.
 */
const MAX_CONNECTION_LIFETIME_MS = 30 * 60_000;

/**
 * Cadence of the alarm-driven lifetime sweep while the room has connections (5
 * minutes).
 *
 * The per-message check ({@link Room.webSocketMessage}) only fires on inbound
 * frames, so a document-idle socket (whose only traffic is the auto-responded
 * `ping`) would never be re-checked. The sweep closes over-age sockets
 * regardless of activity, bounding even a silent connection to at most
 * `MAX_CONNECTION_LIFETIME_MS + CONNECTION_SWEEP_INTERVAL_MS`.
 */
const CONNECTION_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Close code sent when a connection exceeds {@link MAX_CONNECTION_LIFETIME_MS}.
 *
 * App-defined (4000-4999) and deliberately not the client's permanent-auth
 * code (4401): the client's sync supervisor reconnects on every close except
 * 4401, so this code recycles the socket through a fresh authenticated upgrade
 * instead of making the client give up.
 */
const CONNECTION_LIFETIME_CLOSE_CODE = 4408;

/**
 * Close code sent to every live socket when a room is destroyed
 * ({@link Room.destroy}).
 *
 * App-defined (4000-4999) and permanent: the client sync supervisor parks on
 * this code (like the auth-failure 4401) instead of reconnecting, so a device
 * that still had the doc open does not churn reconnects against the tombstoned
 * room. The reason is JSON (`{ code }`) to match the supervisor's permanent-
 * failure parser.
 */
const ROOM_GONE_CLOSE_CODE = 4410;

/** JSON close reason paired with {@link ROOM_GONE_CLOSE_CODE}. */
const ROOM_GONE_CLOSE_REASON = JSON.stringify({ code: 'room_deleted' });

/**
 * Encoded state of an empty Y.Doc. Returned by {@link Room.getDoc} for a
 * destroyed room so a racing client hydrates nothing instead of the lingering
 * in-memory transcript. Computed once at module load.
 */
const EMPTY_DOC_SNAPSHOT: Uint8Array = Y.encodeStateAsUpdateV2(new Y.Doc());

/**
 * Yjs sync + dispatch room backed by a Cloudflare Durable Object.
 *
 * Owns the Hibernation API integration (`acceptWebSocket`,
 * `serializeAttachment`, `setAlarm`) and forwards every meaningful event
 * to the {@link RoomCore} instance built in the constructor.
 *
 * ## Worker to DO interface
 *
 * - **RPC** (`stub.sync()`, `stub.getDoc()`): for HTTP sync and snapshot
 *   bootstrap. Direct method calls avoid Request/Response serialization
 *   overhead for binary payloads.
 * - **fetch** (`stub.fetch(request)`): for WebSocket upgrades only;
 *   the 101 Switching Protocols handshake requires HTTP semantics.
 *
 * ## Auth & data isolation
 *
 * Handled upstream by Hono routes in `@epicenter/server`. The Worker
 * validates the caller, checks any route-owned policy, and builds the
 * internal DO name before calling RPC methods or forwarding `fetch`. The
 * DO itself does not re-validate. DO names are host-owned opaque strings
 * built by `doName(ownerId, roomId)`, producing `owners/<ownerId>/rooms/<roomId>`
 * in both modes (in personal mode `ownerId === user.id`, in shared mode
 * `ownerId === 'shared'`).
 */
export class Room extends DurableObject {
	/**
	 * The runtime-agnostic room logic. Initialized synchronously inside
	 * `ctx.blockConcurrencyWhile()` in the constructor. The definite
	 * assignment assertion is safe because of two guarantees working
	 * together:
	 *
	 * 1. **Cloudflare runtime guarantee**: `blockConcurrencyWhile`
	 *    prevents the DO from receiving any incoming requests until the
	 *    initialization promise resolves.
	 * 2. **Synchronous async callback**: The callback passed to
	 *    `blockConcurrencyWhile` contains no `await`, so it executes to
	 *    completion synchronously.
	 *
	 * If an `await` is ever added to the `blockConcurrencyWhile`
	 * callback, guarantee (2) breaks.
	 *
	 * @see https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile
	 */
	private core!: RoomCore;

	/**
	 * This room's persisted update log. Held so {@link Room.destroy} can empty it
	 * through the owner of the `updates` table rather than running raw SQL.
	 */
	private updateLog!: ReturnType<typeof createDurableObjectUpdateLog>;

	/**
	 * Tombstone for this room. Read synchronously in the constructor and marked
	 * in {@link Room.destroy}. A marked room refuses every doc-touching path.
	 */
	private tombstone!: DurableObjectTombstone;

	/**
	 * Whether this room has been destroyed. Mirrors {@link tombstone} in memory
	 * so every hot path gates on a field read, not a SQL query. Seeded from the
	 * tombstone on cold start so a destroyed room stays destroyed across DO
	 * eviction and reconstruction.
	 */
	private destroyed = false;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);

		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('ping', 'pong'),
		);

		ctx.blockConcurrencyWhile(async () => {
			this.updateLog = createDurableObjectUpdateLog(ctx.storage);
			this.tombstone = createDurableObjectTombstone(ctx.storage);
			this.destroyed = this.tombstone.isDestroyed();
			this.core = createRoomCore({ updateLog: this.updateLog });

			// Restore connections that survived hibernation. The hibernation
			// WebSocket structurally satisfies RoomSocket (send/close/
			// readyState), so we pass the raw ws directly.
			//
			// Presence is rebuilt implicitly: the core's connections map is
			// the source of truth, so once these entries are restored,
			// presence helpers return correct results immediately. No
			// broadcast, no clock seeding, no force-clear; any subsequent
			// upgrade or close drives the next presence delta the same way
			// it would on a never-hibernated DO.
			for (const ws of ctx.getWebSockets()) {
				const attachment = ws.deserializeAttachment() as Connection | null;
				if (!attachment) continue;
				this.core.addConnection(ws, attachment);
			}
		});
	}

	/**
	 * Only handles WebSocket upgrades. HTTP sync operations are exposed
	 * as RPC methods called directly on the stub (see {@link Room.sync}
	 * / {@link Room.getDoc}), avoiding the overhead of constructing and
	 * parsing Request/Response objects for binary payloads.
	 *
	 * Trusts the rooms route to have validated and stamped both `userId`
	 * (from auth) and `deviceId` (from the client query, presence-checked
	 * at the route boundary) onto the URL before forwarding. Together they
	 * form the {@link Connection} stamped on the socket attachment for the
	 * lifetime of the connection. `userId` is what presence carries to
	 * peers; `deviceId` is the address `dispatch({ to })` routes to.
	 *
	 * Cancels any pending compaction alarm: a new client just connected,
	 * so compacting now would be wasteful.
	 *
	 * The client offers
	 * `sec-websocket-protocol: <MAIN_SUBPROTOCOL>, bearer.<token>`; we
	 * echo only the main subprotocol to complete the handshake.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Method not allowed', { status: 405 });
		}

		// A destroyed room accepts no new connections: refuse the upgrade so the
		// client cannot start syncing (and thus cannot re-push) the dead doc.
		if (this.destroyed) {
			return new Response('Room destroyed', { status: 410 });
		}

		const url = new URL(request.url);
		const rawUserId = url.searchParams.get('userId');
		const deviceId = url.searchParams.get('deviceId');
		if (!rawUserId || !deviceId) {
			// Contract violation: the auth-gated rooms route is responsible
			// for validating and stamping both params before forwarding.
			// 500 (not 400) signals this is a server bug, not a client error.
			return new Response(null, { status: 500 });
		}
		// The URL stamp is the binding; brand userId once at the boundary.
		const userId = asUserId(rawUserId);

		// Ensure the lifetime sweep is running. This also supersedes any pending
		// compaction alarm: if one fires while a client is connected, `alarm()`
		// sees connections and sweeps instead of compacting.
		void this.ensureSweepAlarm();

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];

		this.ctx.acceptWebSocket(server);

		// Stash the connection attachment so presence survives hibernation. The
		// device's published action manifest arrives later via `presence_publish`
		// and the core re-serializes the attachment when it does.
		const attachment: Connection = {
			userId,
			deviceId,
			connectedAt: Date.now(),
			actions: {},
		};
		server.serializeAttachment(attachment);

		// Register with the core. addConnection sends the initial
		// SyncStep1 and presence snapshot, and rebroadcasts presence to
		// peers if this is the first socket for the client.
		this.core.addConnection(server, attachment);

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

	/**
	 * Forward inbound messages to the core, after enforcing the connection
	 * lifetime bound.
	 *
	 * A socket past {@link MAX_CONNECTION_LIFETIME_MS} is closed instead of
	 * served, which makes the client reconnect and re-authenticate at a fresh
	 * upgrade (see {@link CONNECTION_LIFETIME_CLOSE_CODE}). The pending message
	 * is dropped; Yjs reconciles it on the next SyncStep1 after reconnect, so no
	 * update is lost. The runtime's `webSocketClose` callback then runs the
	 * normal cleanup and compaction path.
	 */
	override async webSocketMessage(
		ws: WebSocket,
		message: ArrayBuffer | string,
	): Promise<void> {
		// A destroyed room never applies an inbound update: reaching
		// `core.handleMessage` -> `applyUpdateV2` -> `updateLog.append` would
		// resurrect the just-deleted doc. `destroy()` already closed live
		// sockets; this guards a frame that raced the close. Closing an
		// already-closed socket throws, so swallow it.
		if (this.destroyed) {
			try {
				ws.close(ROOM_GONE_CLOSE_CODE, ROOM_GONE_CLOSE_REASON);
			} catch {
				/* already closed by destroy() or the remote end */
			}
			return;
		}
		if (this.closeIfExpired(ws, Date.now())) return;
		this.core.handleMessage(ws, message);
	}

	/**
	 * Close `ws` if it has outlived {@link MAX_CONNECTION_LIFETIME_MS}, returning
	 * whether it did. Used by both the inbound-frame check (immediate, for active
	 * sockets) and the alarm sweep (for idle sockets). The transient
	 * {@link CONNECTION_LIFETIME_CLOSE_CODE} makes the client reconnect through a
	 * fresh authenticated upgrade; the runtime's `webSocketClose` then runs the
	 * normal cleanup and compaction path.
	 */
	private closeIfExpired(ws: WebSocket, now: number): boolean {
		const connection = ws.deserializeAttachment() as Connection | null;
		if (
			connection &&
			now - connection.connectedAt >= MAX_CONNECTION_LIFETIME_MS
		) {
			ws.close(CONNECTION_LIFETIME_CLOSE_CODE, 'connection lifetime exceeded');
			return true;
		}
		return false;
	}

	/**
	 * Arm the lifetime sweep alarm if no alarm is already pending. Idempotent, so
	 * repeated upgrades on a busy room do not keep pushing the sweep out, and a
	 * pending compaction alarm is left in place (it sweeps harmlessly while
	 * clients are connected).
	 */
	private async ensureSweepAlarm(): Promise<void> {
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(
				Date.now() + CONNECTION_SWEEP_INTERVAL_MS,
			);
		}
	}

	/**
	 * Forward close events to the core and schedule deferred compaction
	 * if the room emptied.
	 *
	 * The defensive `ws.close(code, reason)` after the core call covers
	 * a hibernation edge case where the server side outlives the client
	 * side; calling close on an already-closed socket throws and is
	 * swallowed.
	 */
	override async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		this.core.removeConnection(ws, code);

		try {
			ws.close(code, reason);
		} catch {
			/* already closed by the remote end */
		}

		// A destroyed room must NOT schedule compaction. Compaction re-encodes the
		// still-populated in-memory doc and writes it back via `replaceAll`, which
		// would resurrect the transcript into SQLite after `destroy()` emptied it.
		// This is the subtle resurrection path; the `alarm()` guard backs it up.
		if (!this.destroyed && this.core.connectionCount === 0) {
			void this.ctx.storage.setAlarm(Date.now() + COMPACTION_DELAY_MS);
		}
	}

	/**
	 * Handle a WebSocket error by closing with status 1011 (Internal
	 * Error). Delegates to {@link Room.webSocketClose} so the same
	 * cleanup path runs regardless of whether the socket closed cleanly
	 * or errored.
	 */
	override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		await this.webSocketClose(ws, 1011, 'WebSocket error', false);
	}

	/**
	 * The room's single maintenance alarm, multiplexed two ways:
	 *
	 * - While clients are connected it is the periodic lifetime sweep: close
	 *   every over-age socket (including idle ones the per-message check never
	 *   sees), then re-arm for the next {@link CONNECTION_SWEEP_INTERVAL_MS}.
	 *   The swept closes fire `webSocketClose`, which sets the compaction alarm
	 *   once the room empties (overriding this re-arm).
	 * - When the room is empty it compacts the update log (scheduled
	 *   {@link COMPACTION_DELAY_MS} after the last close).
	 *
	 * @see https://developers.cloudflare.com/durable-objects/api/alarms/
	 */
	override async alarm(): Promise<void> {
		// A destroyed room neither sweeps nor compacts: compaction would
		// `replaceAll` the in-memory doc back into the emptied update log.
		if (this.destroyed) return;
		const now = Date.now();
		for (const ws of this.ctx.getWebSockets()) this.closeIfExpired(ws, now);
		if (this.core.connectionCount > 0) {
			void this.ctx.storage.setAlarm(now + CONNECTION_SWEEP_INTERVAL_MS);
			return;
		}
		this.core.compact();
	}

	// --- RPC methods (called via stub.sync() / stub.getDoc()) ---

	/**
	 * HTTP sync via RPC. Forwards to {@link RoomCore.sync}, which
	 * returns a `Result` so the route can answer 400 on a malformed
	 * body without throwing.
	 */
	async sync(body: Uint8Array) {
		// A destroyed room discards the client's update without applying it (no
		// resurrection) and reports itself as empty. The client's local copy is
		// torn down separately once it observes the parent-row tombstone.
		if (this.destroyed) return Ok({ diff: null, storageBytes: 0 });
		return this.core.sync(body);
	}

	/**
	 * Snapshot bootstrap via RPC. Forwards to {@link RoomCore.getDoc}.
	 */
	async getDoc() {
		// A destroyed room exposes an EMPTY snapshot, never the still-populated
		// in-memory doc (it lingers until eviction). `destroy()` emptied the
		// persisted log, so a cold-restarted room returns empty here too.
		if (this.destroyed) {
			return { data: EMPTY_DOC_SNAPSHOT, storageBytes: 0 };
		}
		return this.core.getDoc();
	}

	/**
	 * Permanently destroy this room (RPC, called by the rooms DELETE route).
	 *
	 * Order matters and the durable mutation is atomic:
	 * 1. Flip the in-memory gate so any concurrent RPC starts refusing at once.
	 * 2. In one `transactionSync`, empty the update log and write the tombstone,
	 *    so the room can never be observed half-deleted (data gone, mark missing)
	 *    or half-alive (mark set, data lingering).
	 * 3. Cancel any pending sweep/compaction alarm so no maintenance writer runs.
	 * 4. Close every live socket with the permanent room-gone code so connected
	 *    clients park instead of reconnecting into the 410 upgrade.
	 *
	 * Idempotent: a second call empties an already-empty log and re-marks an
	 * already-marked tombstone.
	 */
	async destroy(): Promise<void> {
		this.destroyed = true;
		this.ctx.storage.transactionSync(() => {
			this.updateLog.clear();
			this.tombstone.mark();
		});
		void this.ctx.storage.deleteAlarm();
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(ROOM_GONE_CLOSE_CODE, ROOM_GONE_CLOSE_REASON);
			} catch {
				/* already closed by the remote end */
			}
		}
	}
}
