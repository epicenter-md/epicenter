/**
 * A stand-in for "the phone": a CLI client of {@link startRemoteServer}'s
 * WebSocket protocol. Connects, prints the live transcript as it streams,
 * and sends whatever you type as a new turn. Proves the floor-tier remote
 * session round-trips with no UI work, the same way `derisk.ts` proved arm
 * A/B co-mounting before host.ts existed.
 *
 * Run: bun run apps/super-app/remote-client.ts [ws://host:port]
 */

import type { RemoteFromServer } from './remote-server.ts';

const url = process.argv[2] ?? 'ws://localhost:4870';
console.log(`Connecting to ${url} ...`);

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
	const frame: RemoteFromServer = JSON.parse(event.data.toString());
	if (frame.type === 'error') {
		console.log(`[error] ${frame.message}`);
		return;
	}
	// Reprint only messages we have not shown yet; the server pushes the
	// whole snapshot on every change, this client just diffs by count. A
	// message renders exactly once, only once it settles into `messages`
	// (never from `streaming`): the scripted/local engines used to verify
	// this transport emit a step's whole answer as one delta, so a separate
	// live-preview render would show the same text twice, once as preview
	// and once settled. A real UI keys one bubble per message id and swaps
	// its render mode in place; this CLI harness just waits for settle.
	const { messages, isGenerating } = frame.snapshot;
	for (const message of messages.slice(printedMessageCount)) {
		printTranscriptMessage(message);
	}
	printedMessageCount = messages.length;
	if (isGenerating && messages.length === printedMessageCount) {
		process.stdout.write('…');
	}
});

socket.addEventListener('close', () => {
	console.log('\nDisconnected.');
	process.exit(0);
});

socket.addEventListener('error', (event) => {
	console.error('WebSocket error:', event);
	process.exit(1);
});

function textOf(message: { parts: { type: string; text?: string }[] }): string {
	return message.parts
		.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
		.map((part) => part.text)
		.join('');
}

function printTranscriptMessage(message: {
	role: string;
	parts: { type: string; text?: string; toolName?: string }[];
}): void {
	const text = textOf(message);
	if (text) console.log(`[${message.role}] ${text}`);
	for (const part of message.parts) {
		if (part.type === 'tool-call') console.log(`  -> call ${part.toolName}`);
		if (part.type === 'tool-result') console.log(`  <- ${part.toolName}`);
	}
}
