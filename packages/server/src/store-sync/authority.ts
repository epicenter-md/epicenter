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
 *
 * It also holds the edition boundary and answers the replace POST (ADR-0231):
 * the sync door refuses a cursor from a retired edition before any socket
 * exists, and the person-owned verb that retires one is a fetch, out of band
 * from sync.
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
	 * Take one authenticated request: a sync upgrade, or the replace POST.
	 *
	 * Called by the route AFTER the bearer has resolved to a principal and the
	 * stub has been addressed by it, so there is nothing left to authorize here.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.method === 'POST') return this.replaceEdition(request);
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('The store transport is WebSocket-only', {
				status: 426,
			});
		}
		const asked = Number(
			new URL(request.url).searchParams.get('cursor') ?? '0',
		);
		const cursor = Number.isFinite(asked) && asked >= 0 ? asked : 0;
		// The edition door, and the whole of edition discovery (ADR-0231). A
		// cursor below the boundary was minted in a retired edition, and it is
		// refused HERE, before any socket exists, so retired bytes have no
		// carrier to arrive on. Zero is not below anything: a replica that never
		// exchanged a byte holds no commitment, and its independent document is
		// the one cross-edition merge that is safe.
		const { data: boundary, error: boundaryError } = this.authority.boundary();
		if (boundaryError !== null) {
			return new Response(boundaryError.message, { status: 500 });
		}
		if (cursor > 0 && cursor < boundary) {
			return Response.json({ boundary }, { status: 409 });
		}
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
		// A frame can be delivered after this object already closed the socket: a
		// push in flight while a replace ran its funeral. `adopt` would resurrect
		// the connection and append RETIRED-edition bytes into the new edition's
		// log, which is the contamination the boundary exists to make impossible
		// (ADR-0231), so a socket this object is done with is deaf here too.
		if (socket.readyState !== WebSocket.OPEN) return;
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
	 * Publish this namespace's next edition (ADR-0231).
	 *
	 * Authority before sockets, in that order and on purpose: the replacement
	 * is durable before anything else learns of it, and the closed sockets
	 * reconnect through the dial, meet the boundary, and that is the whole of
	 * notification. The verb itself lives in `@epicenter/data/sync`; what this
	 * adapter owns is the HTTP shape of the lease and the funeral of the
	 * sockets.
	 */
	private async replaceEdition(request: Request): Promise<Response> {
		const query = new URL(request.url).searchParams;
		const fromBoundary = Number(query.get('fromBoundary'));
		if (!Number.isInteger(fromBoundary) || fromBoundary < 0) {
			return new Response('fromBoundary must be a non-negative integer', {
				status: 400,
			});
		}
		const atHeadRaw = query.get('atHead');
		const atHead = atHeadRaw === null ? undefined : Number(atHeadRaw);
		if (atHead !== undefined && (!Number.isInteger(atHead) || atHead < 0)) {
			return new Response('atHead must be a non-negative integer', {
				status: 400,
			});
		}

		const bytes = new Uint8Array(await request.arrayBuffer());
		// Framing, not reading: a reset posts an encoded EMPTY DOCUMENT, which is
		// still bytes. A body of none is a caller that forgot its body, and the
		// edition it would publish is one no replica could ever adopt.
		if (bytes.length === 0) {
			return new Response('the replacement state must not be empty', {
				status: 400,
			});
		}
		const { data: published, error } = this.authority.replace({
			fromBoundary,
			bytes,
			...(atHead === undefined ? {} : { atHead }),
		});
		if (error !== null) {
			// A lease miss is a refusal that names what moved, so the caller can
			// retry or reconsider; anything else is the storage failing.
			if (error.name === 'BoundaryMoved') {
				return Response.json(
					{ refused: 'boundary', boundary: error.boundary },
					{ status: 409 },
				);
			}
			if (error.name === 'HeadMoved') {
				return Response.json(
					{ refused: 'head', head: error.head },
					{ status: 409 },
				);
			}
			return new Response(error.message, { status: 500 });
		}

		// The old edition's sockets are closed only after the swap is durable.
		// Their replicas reconnect through the dial and are refused by the
		// boundary, which is how they learn; nothing is pushed to them. Forgotten
		// as well as closed, so the hub drops them now rather than when the close
		// event lands.
		for (const socket of this.ctx.getWebSockets()) {
			this.forget(socket);
			socket.close(1000, 'this edition was replaced');
		}
		return Response.json({ boundary: published });
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
