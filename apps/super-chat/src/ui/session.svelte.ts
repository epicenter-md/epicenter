/**
 * The browser side of the Super Chat session: one startup fetch of
 * `/api/session`, one WebSocket to `/api/session/stream`, and a `$state`-backed
 * view the components read. The server snapshot is the only transcript state;
 * every initial payload and `snapshot` event replaces it wholesale, so the
 * client never accumulates a second transcript that could drift.
 *
 * Server types are imported type-only so no server runtime code (Hono, Bun
 * WebSocket glue) enters the browser bundle.
 */

import type { ConversationSnapshot } from '@epicenter/workspace/agent';
import { SESSION_ROUTE, SESSION_STREAM_ROUTE } from '../routes.ts';
import type { ClientCommand, ServerEvent, SessionResponse } from '../server.ts';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

const RECONNECT_DELAY_MS = 1500;

export function createSession({ token }: { token: string }) {
	let snapshot = $state<ConversationSnapshot>({
		messages: [],
		streaming: null,
		isThinking: false,
		isGenerating: false,
		error: null,
	});
	let connection = $state<ConnectionStatus>('connecting');
	let tools = $state<SessionResponse['tools']>([]);

	let socket: WebSocket | undefined;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	async function hydrate() {
		try {
			const response = await fetch(SESSION_ROUTE.url(location.origin), {
				headers: { authorization: `Bearer ${token}` },
			});
			if (!response.ok) {
				connection = 'closed';
				return false;
			}
			const body = (await response.json()) as SessionResponse;
			tools = body.tools;
			snapshot = body.snapshot;
			return true;
		} catch {
			connection = 'closed';
			return false;
		}
	}

	function connect() {
		if (disposed) return;
		connection = 'connecting';
		// The browser WebSocket constructor cannot set headers, so the token
		// rides the query string (the server gate accepts either).
		const url = new URL(SESSION_STREAM_ROUTE.url(location.origin));
		url.searchParams.set('token', token);
		// Match the page's scheme: plain ws: against the loopback origin, wss:
		// when a remote overlay proxy serves this page over https.
		url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const ws = new WebSocket(url);
		socket = ws;
		ws.onopen = () => {
			connection = 'open';
		};
		ws.onmessage = (event) => {
			if (typeof event.data !== 'string') return;
			let parsed: ServerEvent;
			try {
				parsed = JSON.parse(event.data);
			} catch {
				return;
			}
			if (parsed.type === 'snapshot') snapshot = parsed.snapshot;
		};
		ws.onclose = () => {
			if (socket !== ws) return;
			socket = undefined;
			if (disposed) return;
			connection = 'closed';
			reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
		};
	}

	/** Returns whether the command actually went out over an open socket. */
	function sendCommand(command: ClientCommand): boolean {
		if (socket?.readyState !== WebSocket.OPEN) return false;
		socket.send(JSON.stringify(command));
		return true;
	}

	void hydrate().then((ready) => {
		if (ready) connect();
	});

	return {
		get snapshot() {
			return snapshot;
		},
		get connection() {
			return connection;
		},
		get tools() {
			return tools;
		},
		/** Returns whether the message went out, so the composer keeps the draft on failure. */
		send(content: string) {
			return sendCommand({ type: 'send', content });
		},
		stop() {
			sendCommand({ type: 'stop' });
		},
		retry() {
			sendCommand({ type: 'retry' });
		},
		/** Stop reconnecting and close the socket for good. */
		dispose() {
			disposed = true;
			clearTimeout(reconnectTimer);
			socket?.close();
		},
	};
}

export type Session = ReturnType<typeof createSession>;
