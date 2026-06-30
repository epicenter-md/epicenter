/**
 * The "floor" remote-session transport (Slice 2, BYO-overlay tier): a thin
 * WebSocket wrapper around the host's single {@link ConversationHandle}. A
 * second device (phone, laptop) reaches this over the user's own overlay
 * (Tailscale or equivalent) so Epicenter is never in the data path; the
 * overlay's own tunnel crypto is the confidentiality boundary, not anything
 * built here. See ADR-0080 decision 5(a).
 *
 * The protocol is deliberately the same three operations the in-process UI
 * already uses: every connected socket gets a `snapshot` push on connect and
 * on every `chat.subscribe()` notify (so two devices watching the same host
 * see the same live stream, token by token), and a `send` frame from any
 * socket calls `chat.send(content)` straight through. One conversation per
 * host process: every connected client shares the SAME thread, which is the
 * "host-owned, not per-device" model (ADR-0080 decision 2). A registry of
 * separate conversations is later work, not this transport's job.
 */

import type { ConversationHandle } from '@epicenter/workspace/agent';
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('super-app/remote-server');

export type RemoteFromClient = { type: 'send'; content: string };
export type RemoteFromServer =
	| { type: 'snapshot'; snapshot: ReturnType<ConversationHandle['snapshot']> }
	| { type: 'error'; message: string };

export type RemoteServerOptions = {
	chat: ConversationHandle;
	/** Defaults to all interfaces; reachability is the overlay's ACLs, not this bind. */
	hostname?: string;
	port: number;
};

export type RemoteServer = {
	port: number;
	stop(): void;
};

/**
 * Bind the WebSocket endpoint and bridge it to `chat`. Every open socket is
 * pushed a fresh snapshot on every conversation change for as long as it
 * stays connected; `chat.subscribe()` is registered once and fans out to all
 * current sockets, not once per socket, so the loop's single notify drives
 * every viewer.
 */
export function startRemoteServer(options: RemoteServerOptions): RemoteServer {
	const { chat, hostname = '0.0.0.0', port } = options;
	const sockets = new Set<Bun.ServerWebSocket<unknown>>();

	function broadcastSnapshot(): void {
		const frame: RemoteFromServer = { type: 'snapshot', snapshot: chat.snapshot() };
		const body = JSON.stringify(frame);
		for (const socket of sockets) socket.send(body);
	}

	const unsubscribe = chat.subscribe(broadcastSnapshot);

	const server = Bun.serve({
		hostname,
		port,
		fetch(request, server) {
			if (server.upgrade(request)) return undefined;
			return new Response('Upgrade required: connect with a WebSocket client.', {
				status: 426,
			});
		},
		websocket: {
			open(socket) {
				sockets.add(socket);
				log.info('client connected', { clients: sockets.size });
				const frame: RemoteFromServer = { type: 'snapshot', snapshot: chat.snapshot() };
				socket.send(JSON.stringify(frame));
			},
			message(socket, raw) {
				const parsed = parseFromClient(raw.toString());
				if (!parsed) {
					const frame: RemoteFromServer = {
						type: 'error',
						message: 'Expected {"type":"send","content":"..."}',
					};
					socket.send(JSON.stringify(frame));
					return;
				}
				chat.send(parsed.content);
			},
			close(socket) {
				sockets.delete(socket);
				log.info('client disconnected', { clients: sockets.size });
			},
		},
	});

	log.info('remote session listening', { hostname, port: server.port ?? port });

	return {
		port: server.port ?? port,
		stop() {
			unsubscribe();
			server.stop();
		},
	};
}

function parseFromClient(raw: string): RemoteFromClient | null {
	try {
		const value = JSON.parse(raw);
		if (
			value &&
			typeof value === 'object' &&
			value.type === 'send' &&
			typeof value.content === 'string'
		) {
			return value as RemoteFromClient;
		}
		return null;
	} catch {
		return null;
	}
}
