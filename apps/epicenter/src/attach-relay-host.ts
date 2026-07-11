/**
 * Bind one {@link QueryHost} to the AttachRelay (ADR-0115): the desktop
 * host dials out to the per-user rendezvous, registers as a host endpoint, and
 * forwards the same session it already owns to every attached client. This is a
 * second transport for the host-owned session command seam (ADR-0113), beside
 * the direct loopback server in `server.ts`: both drive the one host through
 * `handleCommand` and re-render every client from `host.snapshot()`, so a
 * remote client and a local one attach to the same session, never their own
 * thread (ADR-0080).
 *
 * ## What crosses the relay
 *
 * The host addresses each attached client endpoint on its own wire frame, never
 * a broadcast: on any host change it sends each client its own snapshot, and on
 * a client's command bytes it drives `handleCommand`. The relay routes by the
 * endpoint envelope (`deviceId`, `attachId`) and does not own the Query
 * command or snapshot semantics.
 */

import {
	ATTACH_RELAY_ROUTE,
	type RelayToHostFrame,
} from '@epicenter/server/bun';
import {
	parseQueryCommand,
	type QueryClientCommand,
	type QueryHost,
} from './host.ts';
import type { QueryServerEvent } from './server.ts';

export type AttachRelayHostOptions = {
	/** The one host-owned session every attached client shares. */
	host: QueryHost;
	/** The relay's origin, e.g. `ws://127.0.0.1:<port>` on loopback. */
	relayOrigin: string;
	/**
	 * The principal that owns both ends. An authenticated relay may stamp the
	 * principal server-side, so this is carried only to complete the connect URL's
	 * addressing quadruple and can never authorize cross-partition attach by
	 * itself.
	 */
	principalId: string;
	/** This desktop's stable host id, the endpoint clients attach to. */
	hostId: string;
	/**
	 * This desktop's human label for the host directory ("Braden's Mac"), what a
	 * client sees before it attaches (ADR-0115 clause 3). Directory metadata only:
	 * the mount records it beside the relay, never handing it to the coordinator.
	 * Omitted, the directory lists this host under its `hostId`.
	 */
	label?: string;
	/**
	 * This host's attach credential. On self-host this is a per-device grant; on
	 * Cloud it is the signed-in session bearer. Revoking the credential cuts the
	 * host off on its next connect.
	 */
	bearer: string;
	/**
	 * Open a WebSocket to the relay. Defaults to the global `WebSocket`; tests
	 * inject one so no real global is needed. Kept minimal on purpose: only
	 * `send`, `close`, and the three event hooks the adapter drives.
	 */
	openSocket?: (url: string, protocols?: string[]) => RelayHostSocket;
};

/** The minimal outbound-socket surface the host adapter drives. */
export type RelayHostSocket = {
	send(data: string): void;
	close(): void;
	readyState: number;
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: (() => void) | null;
};

export type AttachRelayHost = {
	/** Resolves once the host has registered with the relay (its socket opened). */
	ready: Promise<void>;
	/** Stop forwarding and drop the relay connection. */
	close(): void;
};

/**
 * Register `host` with the relay and forward its session to every client that
 * attaches. Returns once the connection is initiated; await `ready` to know the
 * host endpoint is live before pointing a client at it.
 */
export function attachHostToRelay(
	options: AttachRelayHostOptions,
): AttachRelayHost {
	const { host, relayOrigin, principalId, hostId, label, bearer } = options;
	const open = options.openSocket ?? defaultOpenSocket;

	const url = ATTACH_RELAY_ROUTE.hostUrl(relayOrigin, {
		principalId,
		hostId,
		label,
	});
	const socket = open(url, ATTACH_RELAY_ROUTE.subprotocols(bearer));

	// The client endpoints currently attached to this host, keyed by
	// `deviceId`/`attachId`. The host re-sends each its own snapshot on change.
	type Client = {
		deviceId: string;
		attachId: string;
	};
	const clients = new Map<string, Client>();
	const clientKey = (deviceId: string, attachId: string): string =>
		`${deviceId} ${attachId}`;

	const sendToClient = (client: Client, payload: string): void => {
		if (socket.readyState !== 1 /* OPEN */) return;
		socket.send(
			JSON.stringify({
				deviceId: client.deviceId,
				attachId: client.attachId,
				payload,
			}),
		);
	};

	const sendSnapshot = (client: Client): void => {
		const event: QueryServerEvent = {
			type: 'snapshot',
			snapshot: host.snapshot(),
		};
		sendToClient(client, JSON.stringify(event));
	};

	// One host subscription for the whole relay transport: on any session change,
	// push a fresh snapshot to each attached client. Client re-render is from
	// host state, never from the frame that triggered the change (ADR-0113).
	const unsubscribe = host.subscribe(() => {
		for (const client of clients.values()) sendSnapshot(client);
	});

	let resolveReady!: () => void;
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});

	// Apply one decoded client command to the one host session. The resulting
	// change fans a fresh snapshot to every attached client.
	const applyCommandPayload = (payload: string): void => {
		const command = parseCommandPayload(payload);
		if (command) host.handleCommand(command);
	};

	socket.onopen = () => resolveReady();
	socket.onmessage = (event) => {
		if (typeof event.data !== 'string') return;
		const frame = parseRelayToHostFrame(event.data);
		if (!frame) return;
		if ('event' in frame) {
			const key = clientKey(frame.deviceId, frame.attachId);
			if (frame.event === 'attach') {
				const client: Client = {
					deviceId: frame.deviceId,
					attachId: frame.attachId,
				};
				clients.set(key, client);
				sendSnapshot(client);
			} else {
				clients.delete(key);
			}
			return;
		}
		applyCommandPayload(frame.payload);
	};
	socket.onclose = () => {
		clients.clear();
	};

	return {
		ready,
		close() {
			unsubscribe();
			clients.clear();
			socket.close();
		},
	};
}

/** The default outbound socket: the global `WebSocket` as a {@link RelayHostSocket}. */
function defaultOpenSocket(url: string, protocols?: string[]): RelayHostSocket {
	return new WebSocket(url, protocols) as unknown as RelayHostSocket;
}

/** Parse one relay-to-host frame; anything off the endpoint-addressed shape drops. */
function parseRelayToHostFrame(data: string): RelayToHostFrame | undefined {
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== 'object') return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.deviceId !== 'string' ||
		typeof record.attachId !== 'string'
	)
		return undefined;
	if (record.event === 'attach' || record.event === 'detach') {
		return {
			deviceId: record.deviceId,
			attachId: record.attachId,
			event: record.event,
		};
	}
	if (typeof record.payload === 'string') {
		return {
			deviceId: record.deviceId,
			attachId: record.attachId,
			payload: record.payload,
		};
	}
	return undefined;
}

/** Decode a client's opaque payload into a host command, or nothing. */
function parseCommandPayload(payload: string): QueryClientCommand | undefined {
	try {
		return parseQueryCommand(JSON.parse(payload));
	} catch {
		return undefined;
	}
}
