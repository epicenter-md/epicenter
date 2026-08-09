/**
 * One principal's authority for one application's store, in a Durable Object.
 *
 * A thin adapter and nothing more. Every rule about who has been sent what
 * lives in `@epicenter/data/sync`, so what is deployed here and what the
 * transport's tests drive are the same object rather than two that agree today.
 *
 * The authority reads nothing (ADR-0218). It holds opaque bytes, hands them
 * back in order, and keeps one snapshot plus the entries after it (ADR-0220).
 * Nothing here imports Yjs or a lens, and there is no verb that could.
 */
import { DurableObject } from 'cloudflare:workers';
import {
	createSyncHub,
	type HubConnection,
	openSyncAuthority,
	type SyncAuthority,
	type SyncHub,
} from '@epicenter/data/sync';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';

/**
 * A socket's position, kept where it survives hibernation.
 *
 * The in-memory map is the fast path and the attachment is the fallback. They
 * can disagree only in the safe direction: a woken object reads a position that
 * is BEHIND, re-sends entries the replica already has, and every one of them is
 * idempotent. The other direction would skip, and a skipped entry is invisible
 * forever.
 */
function positionOf(socket: WebSocket): number {
	const attached = socket.deserializeAttachment() as { cursor?: number } | null;
	return attached?.cursor ?? 0;
}

export class StoreAuthority extends DurableObject {
	private readonly authority: SyncAuthority;
	private readonly hub: SyncHub;
	/** One connection object per live socket, so the hub sees stable identities. */
	private readonly connections = new Map<WebSocket, HubConnection>();

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		const database = createDurableObjectSqliteAdapter(
			ctx.storage as unknown as DurableObjectSqliteStorage,
		);
		this.authority = openSyncAuthority({ database });
		this.hub = createSyncHub({ authority: this.authority });
		// A woken object has sockets and nothing else: no map, and a hub that has
		// never heard of them. Both are rebuilt here, before any message can
		// arrive, from the attachments the sockets carry.
		for (const socket of ctx.getWebSockets()) this.adopt(socket);
	}

	/**
	 * Wrap one socket as a connection, attach it to the hub, and keep its
	 * position durable.
	 *
	 * Joining is not separable from wrapping, and a wake is what proves it. The
	 * hub drops a message from a connection it has not joined, silently and by
	 * design, so an object that rebuilt only `connections` was deaf and mute: it
	 * took every push, stored none, never acknowledged and never refused, and
	 * relayed nothing. A replica cannot tell that apart from a quiet network, so
	 * it holds the work forever believing it is in transit.
	 *
	 * Joining also runs catch-up, which on a wake is the whole recovery.
	 */
	private adopt(socket: WebSocket): HubConnection {
		const existing = this.connections.get(socket);
		if (existing !== undefined) return existing;
		let written = positionOf(socket);
		const connection: HubConnection = {
			cursor: written,
			send(bytes) {
				socket.send(bytes);
				// `serializeAttachment` is a DURABLE STORAGE WRITE. Written after the
				// send rather than before, so a failure leaves the position behind
				// rather than ahead, and only when it actually moved: a chunked entry
				// relayed to several sockets would otherwise be several writes of a
				// value that had not changed.
				if (connection.cursor === written) return;
				written = connection.cursor;
				socket.serializeAttachment({ cursor: written });
			},
		};
		this.connections.set(socket, connection);
		this.hub.join(connection);
		return connection;
	}

	/**
	 * Take one authenticated upgrade.
	 *
	 * Called by the route AFTER the bearer has resolved to a principal and the
	 * stub has been addressed by it, so there is nothing left to authorize here.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('The store transport is WebSocket-only', {
				status: 426,
			});
		}
		const asked = Number(new URL(request.url).searchParams.get('cursor') ?? '0');
		const cursor = Number.isFinite(asked) && asked >= 0 ? asked : 0;
		const pair = new WebSocketPair();

		this.ctx.acceptWebSocket(pair[1]);
		// Written before adopting, because the attachment is where a position
		// comes from: this is the one place it is set from a request rather than
		// read back off the socket, and there is no second source of truth.
		pair[1].serializeAttachment({ cursor });
		// Adopting joins the hub, so catch-up runs here, synchronously, before
		// this handler returns. A Durable Object is single threaded and a socket
		// delivers in order, so everything queued now precedes any relay a later
		// push produces, and the replica's contiguity check holds by construction
		// rather than by luck.
		this.adopt(pair[1]);

		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	override webSocketMessage(
		socket: WebSocket,
		message: ArrayBuffer | string,
	): void {
		if (typeof message === 'string') return;
		// Nothing thrown. `workerd` swallows a throw here WITHOUT closing the
		// socket, so a replica would wait forever on a submission that had already
		// failed; a refusal has to travel as a frame, and the hub sends one.
		this.hub.receive(this.adopt(socket), new Uint8Array(message));
	}

	override webSocketClose(socket: WebSocket): void {
		this.forget(socket);
	}

	override webSocketError(socket: WebSocket): void {
		this.forget(socket);
	}

	private forget(socket: WebSocket): void {
		const connection = this.connections.get(socket);
		if (connection !== undefined) this.hub.leave(connection);
		this.connections.delete(socket);
	}

	/**
	 * Throw this partition's whole log away. Account deletion only.
	 *
	 * One authority holds one application's document, so this is one namespace's
	 * data. Deleting an ACCOUNT means calling it once per namespace; the list is
	 * `DELETABLE_NAMESPACES` and its limits are documented there.
	 */
	async deleteStore(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}
