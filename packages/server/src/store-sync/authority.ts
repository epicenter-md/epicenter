/**
 * One principal's authority for one application's store, in a Durable Object.
 *
 * A thin adapter and nothing more. Every rule about who has been sent what
 * lives in `@epicenter/data/sync`, so what is deployed here and what the
 * transport's tests drive are the same object rather than two that agree today.
 *
 * The authority reads nothing (ADR-0218). It holds opaque bytes, hands them
 * back in order, and keeps one snapshot plus the entries after it (ADR-0220).
 * Nothing here imports Yjs or a workspace, and there is no verb that could.
 *
 * It also names the current document and answers the replace POST
 * (ADR-0231). Connecting is not admission: every authenticated upgrade is
 * accepted, and `hub.join` decides everything. The announcement opens every
 * connection; a replica of a replaced document is never admitted to the
 * relay membership, so it is sent no history and its pushes land nowhere;
 * this class only relays the verdict to the socket. The person-owned verb
 * that replaces a document is a fetch, out of band from sync.
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
 * A socket's position and declared document, kept where they survive
 * hibernation.
 *
 * The in-memory map is the fast path and the attachment is the fallback. They
 * can disagree only in the safe direction: a woken object reads a position that
 * is BEHIND, re-sends entries the replica already has, and every one of them is
 * idempotent. The other direction would skip, and a skipped entry is invisible
 * forever. The document is set once at the dial and never moves.
 */
function attachmentOf(socket: WebSocket): {
	cursor: number;
	document: string | undefined;
} {
	const attached = socket.deserializeAttachment() as {
		cursor?: number;
		document?: string;
	} | null;
	return { cursor: attached?.cursor ?? 0, document: attached?.document };
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
	private adopt(socket: WebSocket): HubConnection | undefined {
		const existing = this.connections.get(socket);
		if (existing !== undefined) return existing;
		const attached = attachmentOf(socket);
		let written = attached.cursor;
		const connection: HubConnection = {
			cursor: written,
			document: attached.document,
			send(bytes) {
				// A closing or closed socket takes nothing more: the hub's send is
				// fire-and-forget, and workerd throws on a dead socket. Reachable
				// when a frame in flight during the funeral re-runs admission and
				// the retired verdict answers a socket the funeral already closed;
				// the replica hears the fact on its next dial instead, which is
				// free.
				if (socket.readyState !== WebSocket.OPEN) return;
				socket.send(bytes);
				// `serializeAttachment` is a DURABLE STORAGE WRITE. Written after the
				// send rather than before, so a failure leaves the position behind
				// rather than ahead, and only when it actually moved: a chunked entry
				// relayed to several sockets would otherwise be several writes of a
				// value that had not changed.
				if (connection.cursor === written) return;
				written = connection.cursor;
				socket.serializeAttachment({
					cursor: written,
					...(connection.document === undefined
						? {}
						: { document: connection.document }),
				});
			},
		};
		const admission = this.hub.join(connection);
		if (admission !== 'admitted') {
			// A retired connection was answered with the document announcement
			// (already on the wire, through the send above); an unreadable
			// document answers nothing, failing closed. Either way there is no
			// membership and no cache entry, so a frame arriving after this
			// close re-runs admission and meets the same verdict, which is what
			// retired the readyState guard this class briefly carried
			// (ADR-0231).
			socket.close(
				1000,
				admission === 'bootstrap'
					? 'bootstrap complete: reconnect with document identity'
					: admission === 'retired'
						? 'document replaced'
						: 'authority unavailable',
			);
			return undefined;
		}
		this.connections.set(socket, connection);
		return connection;
	}

	/**
	 * Take one authenticated request: a sync upgrade, or the replace POST.
	 *
	 * Called by the route AFTER the bearer has resolved to a principal and the
	 * stub has been addressed by it, so there is nothing left to authorize here.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.method === 'POST') return this.replaceDocument(request);
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('The store transport is WebSocket-only', {
				status: 426,
			});
		}
		const query = new URL(request.url).searchParams;
		const asked = Number(query.get('cursor') ?? '0');
		const cursor = Number.isFinite(asked) && asked >= 0 ? asked : 0;
		// The membership fact the cursor cannot carry (ADR-0231): which
		// document this replica's state belongs to. Absent means never
		// stamped, which is also what an old build says. Bounded because it
		// becomes part of a durable attachment.
		const declared = query.get('document');
		const document =
			declared !== null && declared.length > 0 && declared.length <= 128
				? declared
				: undefined;
		const pair = new WebSocketPair();

		this.ctx.acceptWebSocket(pair[1]);
		// Written before adopting, because the attachment is where a position
		// comes from: this is the one place it is set from a request rather than
		// read back off the socket, and there is no second source of truth.
		pair[1].serializeAttachment({
			cursor,
			...(document === undefined ? {} : { document }),
		});
		// Adoption decides everything (ADR-0231): a servable connection joins
		// the hub and catch-up runs here, synchronously, before this handler
		// returns, so the replica's contiguity check holds by construction; a
		// retired one is answered with the document announcement and closed
		// without ever becoming a member. Either way the upgrade itself
		// succeeds, because a browser can read a frame and cannot read a
		// refused handshake.
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
		//
		// `adopt` re-runs admission for a socket this object no longer holds, so
		// a push in flight while a replace ran its funeral meets the identity
		// check at `hub.join` and lands nowhere: the one equality covers
		// dial-time supersession and this race alike (ADR-0231).
		const connection = this.adopt(socket);
		if (connection === undefined) return;
		this.hub.receive(connection, new Uint8Array(message));
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
	 * Publish this workspace's next document (ADR-0231).
	 *
	 * Authority before sockets, in that order and on purpose: the replacement
	 * is durable before anything else learns of it, and the closed sockets
	 * reconnect through the dial, meet a document that is not theirs, and
	 * that is the whole of notification. The verb itself lives in
	 * `@epicenter/data/sync`; what this adapter owns is the HTTP shape of the
	 * lease and the funeral of the sockets.
	 */
	private async replaceDocument(request: Request): Promise<Response> {
		const query = new URL(request.url).searchParams;
		const fromDocument = query.get('fromDocument');
		if (
			fromDocument === null ||
			fromDocument.length === 0 ||
			fromDocument.length > 128
		) {
			return new Response(
				'fromDocument must name the document the replacement was built from',
				{ status: 400 },
			);
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
		// document it would publish is one no replica could ever adopt.
		if (bytes.length === 0) {
			return new Response('the replacement state must not be empty', {
				status: 400,
			});
		}
		const { data: published, error } = this.authority.replace({
			fromDocument,
			bytes,
			...(atHead === undefined ? {} : { atHead }),
		});
		if (error !== null) {
			// A lease miss is a refusal that names what moved, so the caller can
			// reconsider; anything else is the storage failing.
			if (error.name === 'DocumentMoved') {
				return Response.json(
					{ refused: 'document', document: error.document },
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

		// The old document's sockets are closed only after the swap is durable.
		// Their replicas reconnect through the dial, meet a document that is
		// not theirs, and that is how they learn; nothing is pushed to them.
		// Forgotten as well as closed, so the hub drops them now rather than
		// when the close event lands.
		for (const socket of this.ctx.getWebSockets()) {
			this.forget(socket);
			socket.close(1000, 'this document was replaced');
		}
		return Response.json({ document: published });
	}

	/**
	 * Throw this partition's whole log away. Account deletion only.
	 *
	 * One authority holds one application's document, so this is one databaseId's
	 * data. Deleting an ACCOUNT means calling it once per databaseId; the list is
	 * `DELETABLE_NAMESPACES` and its limits are documented there.
	 */
	async deleteStore(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}
