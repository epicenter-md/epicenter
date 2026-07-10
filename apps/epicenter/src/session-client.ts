/**
 * A stand-in for "the phone": a CLI client of the shell's
 * `/api/session/stream` session endpoint. Connects, prints the live transcript
 * as it streams, and sends whatever you type as a new turn.
 *
 * This is the ADR-0080 remote-session proof carried forward from the Slice 1
 * prototype's `remote-client.ts`: every connected socket shares the SAME host
 * conversation, so two devices watching the same host see the same live
 * stream. What changed with ADR-0084: there is no separate, ungated remote
 * server anymore. The one loopback origin is the session endpoint, and a
 * second device reaches it over the user's own overlay (for example a
 * Tailscale proxy onto the loopback port), carrying the same per-launch token
 * every local request carries.
 *
 * Run: bun run apps/query/src/session-client.ts ws://127.0.0.1:<port> <token>
 */

import type { AgentMessage } from '@epicenter/workspace/agent';
import { SESSION_STREAM_ROUTE } from './routes.ts';
import type { QueryServerEvent } from './server.ts';

const [, , origin, token] = process.argv;
if (!origin || !token) {
	console.error(
		'Usage: bun run src/session-client.ts ws://<host>:<port> <token>',
	);
	process.exit(1);
}

const url = `${SESSION_STREAM_ROUTE.url(origin)}?token=${encodeURIComponent(token)}`;
console.log(`Connecting to ${origin} ...`);

const socket = new WebSocket(url);
let printedMessageCount = 0;

socket.addEventListener('open', () => {
	console.log('Connected. Type a message and press enter; Ctrl+D to quit.\n');
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (chunk) => {
		const content = chunk.toString().trim();
		if (!content) return;
		socket.send(JSON.stringify({ type: 'send', content }));
	});
	process.stdin.on('end', () => {
		socket.close();
		process.exit(0);
	});
});

socket.addEventListener('message', (event) => {
	const frame = JSON.parse(String(event.data)) as QueryServerEvent;
	// Print only messages not shown yet; the server pushes the whole snapshot on
	// every change, this client just diffs by count. A message renders once it
	// settles into `messages` (never from `streaming`): a real UI keys one
	// bubble per message id and swaps its render mode in place; this CLI
	// harness just waits for settle.
	const { messages } = frame.snapshot.conversation;
	for (const message of messages.slice(printedMessageCount)) {
		printTranscriptMessage(message);
	}
	printedMessageCount = messages.length;
});

socket.addEventListener('close', () => {
	console.log('\nDisconnected.');
	process.exit(0);
});

socket.addEventListener('error', () => {
	console.error(
		'WebSocket error: is the shell running, and is the token current?',
	);
	process.exit(1);
});

function printTranscriptMessage(message: AgentMessage): void {
	const text = message.parts
		.filter(
			(part): part is { type: 'text'; text: string } => part.type === 'text',
		)
		.map((part) => part.text)
		.join('');
	if (text) console.log(`[${message.role}] ${text}`);
	for (const part of message.parts) {
		if (part.type === 'tool-call') console.log(`  -> call ${part.toolName}`);
		if (part.type === 'tool-result') {
			console.log(`  <- ${part.toolName}${part.isError ? ' [error]' : ''}`);
		}
	}
}
