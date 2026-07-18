/**
 * Route-bound Document Connection Tests
 *
 * Verifies subprotocol negotiation, the deferred symmetric Yjs 14 exchange,
 * the two-zone estimator with suppression and automatic resume, lifecycle
 * classification, retry scheduling, and disposal for one fixed document.
 */
import { describe, expect, test } from 'bun:test';
import {
	DOCUMENT_BACKSTOP_CLOSE_CODE,
	DOCUMENT_BOUND,
	DOCUMENT_FRAME_LIMITS,
	DOCUMENT_SUBPROTOCOL,
	decodeDocumentFrame,
	encodeDocumentFrame,
} from '@epicenter/sync/document-v3';
import * as Y from '@y/y';
import {
	attachAuthenticatedDocumentConnection,
	attachDocumentConnection,
	type DocumentConnectionVerdict,
	rowDocumentWebSocketUrl,
} from './connection.js';

describe('route-bound document connection', () => {
	test('builds the exact structured route without document identity in frames', () => {
		expect(
			rowDocumentWebSocketUrl({
				baseUrl: 'https://api.example/base?ignored=true',
				workspaceId: 'work space',
				address: { table: 'note/type', rowId: 'row #1' },
			}).href,
		).toBe(
			'wss://api.example/api/workspaces/work%20space/tables/note%2Ftype/rows/row%20%231/document',
		);
	});

	test('central auth adapter requests only document-v3 and parks typed denials', async () => {
		const doc = new Y.Doc();
		const requested: string[][] = [];
		const connection = attachAuthenticatedDocumentConnection({
			document: doc,
			url: 'wss://api.example/document',
			openWebSocket(_url, protocols = []) {
				requested.push(protocols);
				return Promise.reject({
					name: 'OpenWebSocketDenied',
					message: 'signed out',
					permanence: 'permanent',
					code: 'signed-out',
				});
			},
		});
		void connection.whenConnected.catch(() => undefined);
		await flush();

		expect(requested).toEqual([[DOCUMENT_SUBPROTOCOL]]);
		expect(connection.status).toEqual({
			phase: 'terminal',
			reason: 'auth',
		});
		connection.dispose();
		doc.destroy();
	});

	test('defers its handshake reply until downstream is applied and measured', async () => {
		const socket = new FakeSocket();
		const doc = createDoc('local');
		const connection = attachDocumentConnection(doc, {
			url: 'https://api.example/documents/notes/note-a',
			openSocket: () => ({ outcome: 'opened', socket: socket.asWebSocket() }),
			classifyClose: networkClose,
		});
		await flush();
		socket.open();
		const request = decodeDocumentFrame(required(socket.sent, 0));
		expect(request.kind).toBe('sync-request');

		const server = createDoc('remote');
		socket.receive({
			kind: 'sync-request',
			stateVector: Y.encodeStateVector(server),
		});
		// The reply is deferred: a naive pre-downstream reply would precede the
		// exact measure the suppression decision needs.
		expect(socket.sent).toHaveLength(1);

		// A local edit made mid-handshake is not sent as its own frame either.
		doc.get('content').insert(0, 'mid-handshake ');
		expect(socket.sent).toHaveLength(1);

		socket.receive({
			kind: 'sync-response',
			update: Y.encodeStateAsUpdateV2(server, Y.encodeStateVector(doc)),
		});
		await connection.whenConnected;
		expect(connection.status).toEqual({ phase: 'connected' });

		// Exactly two client frames after a normal handshake: the initial
		// sync-request and one deferred sync-response.
		expect(socket.sent).toHaveLength(2);
		const reply = decodeDocumentFrame(required(socket.sent, 1));
		if (reply.kind !== 'sync-response') {
			throw new Error('Expected the deferred sync response');
		}
		Y.applyUpdateV2(server, reply.update);
		expect(server.get('content').toString()).toContain('local');
		expect(server.get('content').toString()).toContain('mid-handshake');

		doc.get('content').insert(0, 'new ');
		expect(
			decodeDocumentFrame(required(socket.sent, socket.sent.length - 1)),
		).toMatchObject({ kind: 'update' });
		connection.dispose();
		await connection.whenDisposed;
		doc.destroy();
		server.destroy();
	});

	test('suppresses every upstream frame while downstream keeps applying', async () => {
		const socket = new FakeSocket();
		const doc = createDoc('local');
		const connection = attachDocumentConnection(doc, {
			url: 'https://api.example/document',
			openSocket: () => ({ outcome: 'opened', socket: socket.asWebSocket() }),
			classifyClose: networkClose,
		});
		await flush();
		socket.open();

		const server = new Y.Doc();
		server.get('content').insert(0, 'x'.repeat(DOCUMENT_BOUND.stateBytes + 64));
		socket.receive({
			kind: 'sync-request',
			stateVector: Y.encodeStateVector(server),
		});
		socket.receive({
			kind: 'sync-response',
			update: Y.encodeStateAsUpdateV2(server, Y.encodeStateVector(doc)),
		});
		await connection.whenConnected;

		// Byte-full: the deferred reply is suppressed and the status says so.
		expect(socket.sent).toHaveLength(1);
		expect(connection.status).toEqual({
			phase: 'document-full',
			recoverable: true,
		});

		// Local edits stay durable in the doc but are not sent.
		doc.get('content').insert(0, 'unsent ');
		expect(socket.sent).toHaveLength(1);

		// Downstream keeps flowing while suppressed.
		const beforeRemote = doc.get('content').toString();
		const remoteSv = Y.encodeStateVector(server);
		server.get('content').insert(0, 'remote-progress ');
		socket.receive({
			kind: 'update',
			update: Y.encodeStateAsUpdateV2(server, remoteSv),
		});
		expect(doc.get('content').toString()).not.toBe(beforeRemote);
		expect(doc.get('content').toString()).toContain('remote-progress');

		connection.dispose();
		doc.destroy();
		server.destroy();
	});

	test('byte fullness resumes on its own once deletions shrink the document', async () => {
		const socket = new FakeSocket();
		const doc = new Y.Doc();
		const connection = attachDocumentConnection(doc, {
			url: 'https://api.example/document',
			openSocket: () => ({ outcome: 'opened', socket: socket.asWebSocket() }),
			classifyClose: networkClose,
		});
		await flush();
		socket.open();

		const server = new Y.Doc();
		server.get('content').insert(0, 'y'.repeat(DOCUMENT_BOUND.stateBytes + 64));
		const serverSv = Y.encodeStateVector(server);
		socket.receive({ kind: 'sync-request', stateVector: serverSv });
		socket.receive({
			kind: 'sync-response',
			update: Y.encodeStateAsUpdateV2(server, Y.encodeStateVector(doc)),
		});
		await connection.whenConnected;
		expect(connection.status).toEqual({
			phase: 'document-full',
			recoverable: true,
		});
		expect(socket.sent).toHaveLength(1);

		// The user deletes most of the content; GC shears it and the next exact
		// measure comes back under the bound, which sends the deferred reply as
		// the resume diff and returns the status to connected.
		doc.get('content').delete(0, DOCUMENT_BOUND.stateBytes - 1024);
		expect(connection.status).toEqual({ phase: 'connected' });
		const resume = decodeDocumentFrame(required(socket.sent, 1));
		expect(resume.kind).toBe('sync-response');

		// Ordinary updates flow again.
		doc.get('content').insert(0, 'resumed ');
		expect(
			decodeDocumentFrame(required(socket.sent, socket.sent.length - 1)),
		).toMatchObject({ kind: 'update' });

		connection.dispose();
		doc.destroy();
		server.destroy();
	});

	test('structural fullness reports non-recoverable and never loops', async () => {
		const socket = new FakeSocket();
		const doc = new Y.Doc();
		const connection = attachDocumentConnection(doc, {
			url: 'https://api.example/document',
			openSocket: () => ({ outcome: 'opened', socket: socket.asWebSocket() }),
			classifyClose: networkClose,
		});
		await flush();
		socket.open();

		const server = new Y.Doc();
		// Head inserts in one transaction never merge: struct-dense, byte-small.
		server.transact(() => {
			for (let i = 0; i < DOCUMENT_BOUND.stateStructs + 1; i++) {
				server.get('content').insert(0, 'z');
			}
		});
		socket.receive({
			kind: 'sync-request',
			stateVector: Y.encodeStateVector(server),
		});
		socket.receive({
			kind: 'sync-response',
			update: Y.encodeStateAsUpdateV2(server, Y.encodeStateVector(doc)),
		});
		await connection.whenConnected;
		expect(connection.status).toEqual({
			phase: 'document-full',
			recoverable: false,
		});
		// Deleting content does not shrink the struct dimension; the connection
		// stays suppressed instead of retrying into refusals.
		doc.get('content').delete(0, 1_000);
		expect(connection.status).toEqual({
			phase: 'document-full',
			recoverable: false,
		});
		expect(socket.sent).toHaveLength(1);

		connection.dispose();
		doc.destroy();
		server.destroy();
	});

	test('a 1009 backstop closes retryably and the reconnect measures first', async () => {
		const scheduler = createScheduler();
		const sockets = [new FakeSocket(), new FakeSocket()];
		let opens = 0;
		const doc = createDoc('local');
		const connection = attachDocumentConnection(doc, {
			url: 'wss://api.example/document',
			openSocket: () => ({
				outcome: 'opened',
				socket: required(sockets, opens++).asWebSocket(),
			}),
			// The shared classifier: 1009 is retryable, never terminal.
			classifyClose: ({ code }) =>
				code === 1002
					? { outcome: 'terminal', reason: 'upgrade' }
					: { outcome: 'retry', reason: 'network' },
			schedule: scheduler.schedule,
			random: () => 0,
		});
		await flush();
		const first = required(sockets, 0);
		first.open();
		const server = new Y.Doc();
		socketHandshake(first, server, doc);
		await connection.whenConnected;
		expect(connection.status).toEqual({ phase: 'connected' });

		// The authority refuses a racing update with the backstop close.
		first.serverClose(DOCUMENT_BACKSTOP_CLOSE_CODE, 'too-large');
		expect(connection.status).toMatchObject({
			phase: 'pending',
			reason: 'network',
		});

		// The reconnect applies downstream (now over the bound) and measures
		// before replying: it suppresses, so one crossing costs one refusal.
		scheduler.runNext();
		await flush();
		const second = required(sockets, 1);
		second.open();
		server.get('content').insert(0, 'x'.repeat(DOCUMENT_BOUND.stateBytes));
		socketHandshake(second, server, doc);
		expect(connection.status).toEqual({
			phase: 'document-full',
			recoverable: true,
		});
		const upstream = second.sent.filter(
			(bytes) => decodeDocumentFrame(bytes).kind !== 'sync-request',
		);
		expect(upstream).toHaveLength(0);

		connection.dispose();
		doc.destroy();
		server.destroy();
	});

	test('a maximal legal canonical state fits the reconnect frame envelope', async () => {
		const socket = new FakeSocket();
		const doc = new Y.Doc();
		const connection = attachDocumentConnection(doc, {
			url: 'https://api.example/document',
			openSocket: () => ({ outcome: 'opened', socket: socket.asWebSocket() }),
			classifyClose: networkClose,
		});
		await flush();
		socket.open();

		const server = new Y.Doc();
		server.get('content').insert(0, 'm'.repeat(1_040_000));
		const state = Y.encodeStateAsUpdateV2(server);
		expect(state.byteLength).toBeLessThanOrEqual(DOCUMENT_BOUND.stateBytes);
		expect(state.byteLength + DOCUMENT_FRAME_LIMITS.headerBytes).toBeLessThan(
			DOCUMENT_FRAME_LIMITS.encodedFrameBytes,
		);
		socket.receive({
			kind: 'sync-request',
			stateVector: Y.encodeStateVector(server),
		});
		socket.receive({ kind: 'sync-response', update: state });
		await connection.whenConnected;
		expect(connection.status).toEqual({ phase: 'connected' });
		expect(doc.get('content').toString()).toHaveLength(1_040_000);

		connection.dispose();
		doc.destroy();
		server.destroy();
	});

	test('retries a non-terminal admission with injected backoff', async () => {
		const scheduler = createScheduler();
		const socket = new FakeSocket();
		let opens = 0;
		const doc = new Y.Doc();
		const connection = attachDocumentConnection(doc, {
			url: 'https://api.example/document',
			openSocket() {
				opens += 1;
				return opens === 1
					? { outcome: 'retry', reason: 'network' }
					: { outcome: 'opened', socket: socket.asWebSocket() };
			},
			classifyClose: networkClose,
			schedule: scheduler.schedule,
			random: () => 0,
		});
		await flush();

		expect(connection.status).toEqual({
			phase: 'pending',
			reason: 'network',
			retryInMs: 250,
		});
		expect(scheduler.tasks).toHaveLength(1);
		expect(scheduler.tasks[0]?.delayMs).toBe(250);
		scheduler.runNext();
		await flush();
		expect(opens).toBe(2);
		expect(connection.status).toEqual({ phase: 'connecting', attempt: 1 });

		void connection.whenConnected.catch(() => undefined);
		connection.dispose();
		doc.destroy();
	});

	test('parks terminal auth and upgrade admissions', async () => {
		for (const reason of ['auth', 'upgrade'] as const) {
			const scheduler = createScheduler();
			const doc = new Y.Doc();
			const connection = attachDocumentConnection(doc, {
				url: 'https://api.example/document',
				openSocket: () => ({ outcome: 'terminal', reason }),
				classifyClose: networkClose,
				schedule: scheduler.schedule,
			});
			void connection.whenConnected.catch(() => undefined);
			await flush();

			expect(connection.status).toEqual({ phase: 'terminal', reason });
			expect(scheduler.tasks).toEqual([]);
			connection.dispose();
			doc.destroy();
		}
	});

	test('explicit disposal cancels retry without owning document destruction', async () => {
		const scheduler = createScheduler();
		const doc = new Y.Doc();
		const connection = attachDocumentConnection(doc, {
			url: 'https://api.example/document',
			openSocket: () => ({ outcome: 'retry', reason: 'network' }),
			classifyClose: networkClose,
			schedule: scheduler.schedule,
		});
		void connection.whenConnected.catch(() => undefined);
		await flush();
		expect(scheduler.tasks).toHaveLength(1);

		connection.dispose();
		await connection.whenDisposed;
		expect(connection.status).toEqual({ phase: 'disposed' });
		expect(scheduler.tasks[0]?.cancelled).toBe(true);
		expect(doc.isDestroyed).toBe(false);
		doc.destroy();
	});

	test('refuses a socket that did not negotiate the document subprotocol', async () => {
		const socket = new FakeSocket('another-protocol');
		const doc = new Y.Doc();
		const connection = attachDocumentConnection(doc, {
			url: 'https://api.example/document',
			openSocket: () => ({ outcome: 'opened', socket: socket.asWebSocket() }),
			classifyClose: () => ({ outcome: 'terminal', reason: 'upgrade' }),
		});
		void connection.whenConnected.catch(() => undefined);
		await flush();
		socket.open();

		expect(socket.clientCloses).toEqual([
			{ code: 1002, reason: 'document subprotocol mismatch' },
		]);
		connection.dispose();
		doc.destroy();
	});
});

function networkClose(): DocumentConnectionVerdict {
	return { outcome: 'retry', reason: 'network' };
}

function createDoc(content: string): Y.Doc {
	const doc = new Y.Doc();
	doc.get('content').insert(0, content);
	return doc;
}

function socketHandshake(socket: FakeSocket, server: Y.Doc, doc: Y.Doc): void {
	socket.receive({
		kind: 'sync-request',
		stateVector: Y.encodeStateVector(server),
	});
	socket.receive({
		kind: 'sync-response',
		update: Y.encodeStateAsUpdateV2(server, Y.encodeStateVector(doc)),
	});
}


function flush(): Promise<void> {
	return new Promise((resolve) => queueMicrotask(resolve));
}

function required<T>(values: readonly T[], index: number): T {
	const value = values[index];
	if (value === undefined) throw new Error(`Expected value at index ${index}`);
	return value;
}

class FakeSocket {
	readyState = 0;
	binaryType: BinaryType = 'blob';
	onopen: ((event: Event) => unknown) | null = null;
	onmessage: ((event: MessageEvent) => unknown) | null = null;
	onerror: ((event: Event) => unknown) | null = null;
	onclose: ((event: CloseEvent) => unknown) | null = null;
	readonly sent: Uint8Array[] = [];
	readonly clientCloses: { code?: number; reason?: string }[] = [];

	constructor(readonly protocol = DOCUMENT_SUBPROTOCOL) {}

	asWebSocket(): WebSocket {
		return this as unknown as WebSocket;
	}

	send(data: ArrayBuffer | ArrayBufferView): void {
		const bytes =
			data instanceof ArrayBuffer
				? new Uint8Array(data)
				: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		this.sent.push(bytes.slice());
	}

	close(code?: number, reason?: string): void {
		this.clientCloses.push({
			...(code === undefined ? {} : { code }),
			...(reason === undefined ? {} : { reason }),
		});
		this.readyState = 2;
	}

	open(): void {
		this.readyState = 1;
		this.onopen?.(new Event('open'));
	}

	receive(frame: Parameters<typeof encodeDocumentFrame>[0]): void {
		const encoded = encodeDocumentFrame(frame);
		this.onmessage?.(new MessageEvent('message', { data: encoded.buffer }));
	}

	serverClose(code: number, reason: string): void {
		this.readyState = 3;
		this.onclose?.(
			new CloseEvent('close', { code, reason, wasClean: code === 1000 }),
		);
	}
}

function createScheduler() {
	type Task = {
		task: () => void;
		delayMs: number;
		cancelled: boolean;
	};
	const tasks: Task[] = [];
	return {
		tasks,
		schedule(task: () => void, delayMs: number) {
			const scheduled = { task, delayMs, cancelled: false };
			tasks.push(scheduled);
			return () => {
				scheduled.cancelled = true;
			};
		},
		runNext() {
			const next = tasks.shift();
			if (!next) throw new Error('Expected a scheduled task');
			if (!next.cancelled) next.task();
		},
	};
}
