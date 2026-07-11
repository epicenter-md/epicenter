/**
 * A client endpoint of the AttachRelay (ADR-0115): the "phone" or second
 * browser that attaches to one desktop's Query host and shares its live
 * session. It sends host-owned commands (ADR-0113) as opaque bytes and renders
 * from the host snapshots the relay forwards back; the relay routes by endpoint
 * envelope and does not own command semantics.
 *
 * This is the same session command surface the direct loopback client speaks
 * (`ui/session.svelte.ts`, `session-client.ts`); only the transport differs. It
 * is transport-thin on purpose: the host snapshot is the whole render state, so
 * this client just holds the latest one and fans it to subscribers.
 */

import { ATTACH_RELAY_ROUTE } from '@epicenter/server/bun';
import type { QueryClientCommand } from './host.ts';
import type { QueryServerEvent } from './server.ts';

export type AttachRelayClientOptions = {
	/** The relay's origin, e.g. `ws://127.0.0.1:<port>` on loopback. */
	relayOrigin: string;
	/** The principal that owns both this device and the host it attaches to. */
	principalId: string;
	/** The desktop host endpoint to attach to. */
	hostId: string;
	/** This device's id; with `attachId` it is this client endpoint's address. */
	deviceId: string;
	/** This attach session's id, unique per attach on the device. */
	attachId: string;
	/**
	 * This device's attach credential. On self-host this is a per-device grant; on
	 * Cloud it is the signed-in session bearer. The relay authenticates the socket
	 * before any attach reaches the coordinator.
	 */
	bearer: string;
	/** Inject the socket opener in tests; defaults to the global `WebSocket`. */
	openSocket?: (url: string, protocols?: string[]) => RelayClientSocket;
};

/** The minimal client-socket surface this adapter drives. */
export type RelayClientSocket = {
	send(data: string): void;
	close(): void;
	readyState: number;
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: (() => void) | null;
};

export type AttachRelayClient = {
	/** Resolves once the socket is open and this client can send. */
	ready: Promise<void>;
	/** Send one host command as opaque bytes to the shared session. */
	send(command: QueryClientCommand): void;
	/** The most recent host snapshot, or undefined before the first arrives. */
	latest(): QueryServerEvent | undefined;
	/** Observe every host snapshot forwarded to this endpoint. */
	subscribe(listener: (event: QueryServerEvent) => void): () => void;
	/** Detach and drop the connection. */
	close(): void;
};

/** Attach to a host endpoint through the relay and mirror its session. */
export function createAttachRelayClient(
	options: AttachRelayClientOptions,
): AttachRelayClient {
	const open = options.openSocket ?? defaultOpenSocket;
	const url = ATTACH_RELAY_ROUTE.clientUrl(options.relayOrigin, {
		principalId: options.principalId,
		hostId: options.hostId,
		deviceId: options.deviceId,
		attachId: options.attachId,
	});
	const socket = open(url, ATTACH_RELAY_ROUTE.subprotocols(options.bearer));

	let latest: QueryServerEvent | undefined;
	const listeners = new Set<(event: QueryServerEvent) => void>();

	let resolveReady!: () => void;
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});

	const deliver = (data: string): void => {
		const parsed = parseServerEvent(data);
		if (!parsed) return;
		latest = parsed;
		for (const listener of listeners) listener(parsed);
	};

	socket.onopen = () => resolveReady();
	socket.onmessage = (event) => {
		if (typeof event.data !== 'string') return;
		deliver(event.data);
	};

	return {
		ready,
		send(command) {
			if (socket.readyState !== 1 /* OPEN */) return;
			// The command is the opaque payload; the relay forwards it without owning
			// or interpreting Query command semantics.
			socket.send(JSON.stringify(command));
		},
		latest() {
			return latest;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close() {
			listeners.clear();
			socket.close();
		},
	};
}

function defaultOpenSocket(
	url: string,
	protocols?: string[],
): RelayClientSocket {
	return new WebSocket(url, protocols) as unknown as RelayClientSocket;
}

/** Parse a forwarded host snapshot; a non-snapshot or malformed frame drops. */
function parseServerEvent(data: string): QueryServerEvent | undefined {
	try {
		const value = JSON.parse(data) as QueryServerEvent;
		return value.type === 'snapshot' ? value : undefined;
	} catch {
		return undefined;
	}
}
