/**
 * The browser side of the Query session: one startup fetch of
 * the Query session API, one Query session WebSocket, and a `$state`-backed
 * view the components read. The server snapshot is the only transcript state;
 * every initial payload and `snapshot` event replaces it wholesale, so the
 * client never accumulates a second transcript that could drift.
 *
 * Host and server types are imported type-only so no server runtime code
 * (Hono, Bun WebSocket glue, node builtins) enters the browser bundle.
 */

import type { ConversationSnapshot } from '@epicenter/workspace/agent';
import type {
	PendingApproval,
	QueryClientCommand,
	QueryInvocation,
} from '../host.ts';
import { SESSION_ROUTE, SESSION_STREAM_ROUTE } from '../routes.ts';
import type { QueryServerEvent, QuerySessionResponse } from '../server.ts';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

const RECONNECT_DELAY_MS = 1500;

export function createSession({ ready }: { ready: Promise<void> }) {
	let snapshot = $state<ConversationSnapshot>({
		messages: [],
		streaming: null,
		isThinking: false,
		isGenerating: false,
		error: null,
	});
	let pendingApprovals = $state<PendingApproval[]>([]);
	let invocations = $state<QueryInvocation[]>([]);
	let connection = $state<ConnectionStatus>('connecting');
	let tools = $state<QuerySessionResponse['tools']>([]);

	let socket: WebSocket | undefined;

	async function hydrate() {
		try {
			const response = await fetch(SESSION_ROUTE.url(location.origin));
			if (!response.ok) {
				connection = 'closed';
				return false;
			}
			const body = (await response.json()) as QuerySessionResponse;
			tools = body.tools;
			snapshot = body.snapshot.conversation;
			pendingApprovals = body.snapshot.pendingApprovals;
			invocations = body.snapshot.invocations;
			return true;
		} catch {
			connection = 'closed';
			return false;
		}
	}

	function connect() {
		connection = 'connecting';
		const url = new URL(SESSION_STREAM_ROUTE.url(location.origin));
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
			let parsed: QueryServerEvent;
			try {
				parsed = JSON.parse(event.data);
			} catch {
				return;
			}
			if (parsed.type === 'snapshot') {
				snapshot = parsed.snapshot.conversation;
				pendingApprovals = parsed.snapshot.pendingApprovals;
				invocations = parsed.snapshot.invocations;
			}
		};
		ws.onclose = () => {
			if (socket !== ws) return;
			socket = undefined;
			connection = 'closed';
			setTimeout(connect, RECONNECT_DELAY_MS);
		};
	}

	/** Returns whether the command actually went out over an open socket. */
	function sendCommand(command: QueryClientCommand): boolean {
		if (socket?.readyState !== WebSocket.OPEN) return false;
		socket.send(JSON.stringify(command));
		return true;
	}

	void ready
		.then(hydrate)
		.then((isHydrated) => {
			if (isHydrated) connect();
		})
		.catch(() => {
			connection = 'closed';
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
		get pendingApprovals() {
			return pendingApprovals;
		},
		get invocations() {
			return invocations;
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
		/** Start a fresh conversation; the old transcript stays durable on the host. */
		clear() {
			sendCommand({ type: 'clear' });
		},
		/** Run one tool directly; the result lands in `invocations`. */
		invoke(
			toolName: string,
			input: Extract<QueryClientCommand, { type: 'invoke' }>['input'] = {},
		) {
			return sendCommand({ type: 'invoke', toolName, input });
		},
		approve(
			requestId: string,
			approved: boolean,
			alwaysAllowSession: boolean = false,
		) {
			sendCommand({
				type: 'approve',
				requestId,
				approved,
				...(alwaysAllowSession && { alwaysAllowSession }),
			});
		},
	};
}
