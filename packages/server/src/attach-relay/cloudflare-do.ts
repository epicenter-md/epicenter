/**
 * Cloudflare Durable Object backend for the {@link createAttachRelay}
 * coordinator (ADR-0115): the hosted Cloud transport that holds the live
 * rendezvous sockets between a signed-in desktop Super Chat host and a signed-in
 * phone/client of the same principal, and answers that principal's host
 * discovery. It is the Cloud twin of the Bun transport (`attach-relay/bun-server`);
 * both drive the one runtime-agnostic coordinator.
 *
 * ## One AttachHub per principal
 *
 * The coordinator pairs a host with its clients in memory, so a host and every
 * client attaching to it MUST land on the same actor. {@link createDurableObjectAttachHub}
 * derives the DO name from `principalId` alone ({@link attachHubDoName}), so every
 * socket of one principal, host and client alike, routes to that principal's one
 * hub. That is the coordinator's native shape (the Bun self-host runs one
 * coordinator for the principal too): `hostKey(principalId, hostId)` and
 * `liveHostIds(principalId)` finally hold many hosts, not one. The `principalId`
 * is the partition: a client whose bearer resolves to another principal, even one
 * guessing a `hostId`, is stamped with its OWN principal and routes to its own
 * hub (holding none of the target's hosts), so it pairs with no host,
 * HOST_NOT_FOUND. That is the same account-isolation invariant `cloud-attach.test.ts`
 * proves through the mount.
 *
 * ## The hub owns discovery too: no cross-DO push
 *
 * Because the read surface (`GET /attach/hosts`) and the live sockets share one
 * actor, the hub answers `list(principalId)` by joining its retained
 * membership+label (`ctx.storage`) with the coordinator's live host set
 * (`liveHostIds`), exactly as the Bun reader does. Liveness is never a stored,
 * pushed flag that can drift from the socket that actually forwards frames: the
 * only honest source is the live socket, and it lives right here (the spec's
 * "reject the heartbeat and the PUT"). A dead host is dropped by the coordinator
 * and renders `offline`; an asleep desktop still lists because membership is
 * retained. There is no separate directory DO and no `recordOpen`/`recordClose`
 * RPC.
 *
 * ## Standard accept, not the hibernation API
 *
 * Unlike the room DO, this backend accepts sockets with `server.accept()` rather
 * than the WebSocket Hibernation API. A live attach keeps both ends online (the
 * relay stores no frames and needs both peers, ADR-0115 clause 5), so pinning the
 * DO in memory for the connection's life is honest: the in-memory coordinator
 * stays coherent with its open sockets with no attachment serialization and no
 * rebuild-on-wake. Hibernation would also have to replay the coordinator's
 * per-client `attach` lifecycle event on every wake, re-pushing snapshots the
 * host already sent; standard accept sidesteps that entirely. The hub's only
 * `ctx.storage` is the retained membership+label the discovery read joins against;
 * it arms no alarm and the coordinator is a pure socket router.
 *
 * ## RelaySocket compatibility
 *
 * Cloudflare's `WebSocket` exposes `send`, `close(code, reason)`, and
 * `readyState`, so it structurally satisfies {@link RelaySocket} and the raw
 * socket is handed straight to the coordinator with no wrapper, the same move the
 * Bun and room backends make.
 */

import { DurableObject } from 'cloudflare:workers';
import { asPrincipalId } from '@epicenter/identity';
import { MAIN_SUBPROTOCOL, parseSubprotocols } from '@epicenter/sync';
import { attachHubDoName } from '../principal.js';
import {
	type AttachRelayUpgradeHandler,
	parseAttachEndpoint,
} from './contracts.js';
import { createAttachRelay } from './core.js';
import type {
	AttachHostDirectoryEntry,
	HostDirectoryReader,
} from './host-directory.js';

/** The `ctx.storage` key for one host's retained directory record. */
const hostKey = (hostId: string): string => `host:${hostId}`;
const HOST_KEY_PREFIX = 'host:';

/**
 * One host's retained directory record: its human label, and nothing else.
 * Liveness is NOT stored: it is the coordinator's live host set, joined at read
 * time, so this record can never drift into a stale `online`.
 */
type HostRecord = { label: string };

/**
 * The AttachHub actor: one {@link createAttachRelay} coordinator plus this
 * principal's retained host membership, behind a Cloudflare Durable Object.
 * Cloudflare instantiates it per DO name (one per principal). `fetch` is the
 * WebSocket surface (a 101-returning attach upgrade); `list` is the discovery
 * read the host-directory reader drives. Its only `ctx.storage` is the retained
 * membership+label; it arms no alarm.
 */
export class AttachHub extends DurableObject {
	/**
	 * The runtime-agnostic relay coordinator for this principal's sockets. A plain
	 * field initializer suffices: standard-accept sockets pin the DO in memory, so
	 * there is no hibernation restore to run in the constructor (contrast the room
	 * DO's `blockConcurrencyWhile` rebuild). When the hub wakes for a discovery
	 * read with no live sockets, this coordinator is freshly empty, so every
	 * retained host renders `offline`.
	 */
	private readonly relay = createAttachRelay();

	/**
	 * Accept one authenticated attach upgrade. The Worker's attach route has
	 * already resolved the bearer, stamped `principalId` server-side, and routed
	 * this request to this principal's hub; the hub reads the endpoint quadruple
	 * back off the forwarded URL and validates its shape.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Method not allowed', { status: 405 });
		}

		const url = new URL(request.url);
		const endpoint = parseAttachEndpoint({
			principalId: url.searchParams.get('principalId') ?? undefined,
			role: url.searchParams.get('role') ?? undefined,
			hostId: url.searchParams.get('hostId') ?? undefined,
			deviceId: url.searchParams.get('deviceId') ?? undefined,
			attachId: url.searchParams.get('attachId') ?? undefined,
			// A host's directory label rides the connect URL (`route.ts` `hostUrl`);
			// the hub reads it back here to record membership. It never reaches the
			// coordinator, which stays label-blind.
			label: url.searchParams.get('label') ?? undefined,
		});
		if (!endpoint) {
			return new Response('Bad attach request', { status: 400 });
		}

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		server.accept();

		// Read BEFORE registering: a host wins its `hostId` only when the
		// coordinator holds no live host under it yet. Only a winner records
		// membership, so a refused second host (HOST_CONFLICT) never overwrites the
		// incumbent's label. This is the per-principal form of the coordinator's
		// own conflict-correct liveness (`liveHostIds`): a `.length === 0` check
		// would be wrong here, where the hub legitimately holds many hosts at once.
		const hostWonRegistration =
			endpoint.role === 'host' &&
			!this.relay.liveHostIds(endpoint.principalId).includes(endpoint.hostId);

		// Register or attach on the coordinator. It may synchronously close `server`
		// here (HOST_CONFLICT for a second host, HOST_NOT_FOUND for a client with no
		// live host); the 101 still completes and the client reads the app close
		// code, the same accept-then-close shape the rooms reject path uses.
		const connection =
			endpoint.role === 'host'
				? this.relay.registerHost({
						principalId: endpoint.principalId,
						hostId: endpoint.hostId,
						socket: server,
					})
				: this.relay.attachClient({
						principalId: endpoint.principalId,
						hostId: endpoint.hostId,
						deviceId: endpoint.deviceId,
						attachId: endpoint.attachId,
						socket: server,
					});

		if (endpoint.role === 'host' && hostWonRegistration) {
			// Record membership+label so an asleep desktop still lists as `offline`
			// after this hub evicts. Liveness is NOT stored: `list` joins this
			// retained membership with the live socket set, so a crashed host is
			// never a stale `online` (the coordinator drops it, this pinned hub sees
			// the TCP close). `waitUntil` keeps the write off the 101's critical
			// path; the open socket pins this DO, so it still runs. A reconnect with
			// a fresh label re-asserts the same membership and refreshes the label.
			const { hostId, label } = endpoint;
			this.ctx.waitUntil(
				this.ctx.storage.put<HostRecord>(hostKey(hostId), {
					label: label && label.length > 0 ? label : hostId,
				}),
			);
		}

		server.addEventListener('message', (event) => {
			// The relay wire is opaque JSON text; a binary frame is not part of the
			// contract, so ignore it rather than coerce it to `[object ArrayBuffer]`.
			if (typeof event.data === 'string') connection.receive(event.data);
		});
		const disconnect = () => connection.close();
		server.addEventListener('close', disconnect);
		server.addEventListener('error', disconnect);

		// Echo only the main subprotocol on the 101, so a `bearer.<token>` a browser
		// offered is never round-tripped back to it.
		const headers = new Headers();
		const offered = parseSubprotocols(
			request.headers.get('sec-websocket-protocol'),
		);
		if (offered.includes(MAIN_SUBPROTOCOL)) {
			headers.set('sec-websocket-protocol', MAIN_SUBPROTOCOL);
		}
		return new Response(null, { status: 101, webSocket: client, headers });
	}

	/**
	 * This principal's hosts as closed `{ hostId, label, status }` entries: the
	 * retained membership+label joined with the coordinator's live host set. A
	 * live host renders `online`, a retained-but-not-live one `offline`. This is
	 * the whole of what `GET /attach/hosts` returns; it names no route, capability,
	 * action, or tool (ADR-0115 clause 3). The `principalId` is the hub's own (the
	 * reader passes the server-stamped bearer's), so it filters the coordinator to
	 * this principal's hosts, which is all of them.
	 */
	async list(principalId: string): Promise<AttachHostDirectoryEntry[]> {
		const live = new Set(this.relay.liveHostIds(principalId));
		const records = await this.ctx.storage.list<HostRecord>({
			prefix: HOST_KEY_PREFIX,
		});
		return Array.from(records, ([key, record]) => {
			const hostId = key.slice(HOST_KEY_PREFIX.length);
			return {
				hostId,
				label: record.label,
				status: live.has(hostId) ? 'online' : 'offline',
			};
		});
	}
}

/**
 * Build the Cloud relay backend over a `DurableObjectNamespace`, the seam
 * {@link mountAttachRelayApp}'s `resolveRelay` returns on Cloudflare. Resolves
 * each upgrade to this principal's hub and forwards the request (a 101-returning
 * `fetch`), stamping the server-resolved principal over any client-supplied value
 * first. This mirrors `createDurableObjectRooms`: the `idFromName` derivation and
 * the `fetch`-as-upgrade convention live here, in the Cloudflare backend, never
 * in the backend-blind mount. The router's only job is principal to hub; the hub
 * validates the full endpoint shape (a missing `hostId` is the hub's 400).
 */
export function createDurableObjectAttachHub(
	namespace: DurableObjectNamespace<AttachHub>,
): AttachRelayUpgradeHandler {
	return {
		handleUpgrade({ request, principalId }) {
			const name = attachHubDoName(asPrincipalId(principalId));
			const stub = namespace.get(namespace.idFromName(name));
			// Stamp the server-resolved principal over any client-supplied value, then
			// forward. Reconstructing the request is fine on Cloudflare: it matches the
			// socket by the DO it routes to, not by request-object identity the way
			// Bun's `server.upgrade` does.
			const url = new URL(request.url);
			url.searchParams.set('principalId', principalId);
			return stub.fetch(new Request(url.toString(), request));
		},
	};
}

/**
 * Build the Cloud host directory reader over the same AttachHub namespace, the
 * seam `mountHostDirectoryApp`'s `resolveHostDirectory` returns on Cloudflare.
 * Discovery reads the SAME per-principal actor that holds the live sockets, so
 * `list(principalId)` is a read-time join of retained membership and live
 * liveness, never a fan-out and never a pushed flag. The principal is the
 * server-stamped bearer's, so a client only ever reads its own hub.
 */
export function createDurableObjectHostDirectory(
	namespace: DurableObjectNamespace<AttachHub>,
): HostDirectoryReader {
	return {
		list(principalId) {
			const name = attachHubDoName(asPrincipalId(principalId));
			return namespace.get(namespace.idFromName(name)).list(principalId);
		},
	};
}
