/**
 * Route-bound Document Connection Tests
 *
 * Verifies subprotocol negotiation, symmetric Yjs 14 exchange, lifecycle
 * classification, retry scheduling, and disposal for one fixed document.
 */
import { describe, expect, test } from 'bun:test';
import {
	DOCUMENT_CLOSE_CODE,
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

	test('negotiates the document protocol and completes a symmetric Yjs 14 handshake', async () => {
		const socket = new FakeSocket();
		const requested: { url: string; protocols: string[] }[] = [];
		const doc = createDoc('local');
		const connection = attachDocumentConnection(doc, {
			url: 'https://api.example/documents/notes/note-a',
			openSocket(url, protocols) {
				requested.push({ url: String(url), protocols });
				return { outcome: 'opened', socket: socket.asWebSocket() };
			},
			classifyClose: networkClose,
		});
		await flush();

		expect(requested).toEqual([
			{
				url: 'https://api.example/documents/notes/note-a',
				protocols: [DOCUMENT_SUBPROTOCOL],
			},
		]);
		socket.open();
		const request = decodeDocumentFrame(required(socket.sent, 0));
		expect(request.kind).toBe('sync-request');

		const server = createDoc('remote');
		socket.receive({
			kind: 'sync-request',
			stateVector: Y.encodeStateVector(server),
		});
		const localDiff = decodeDocumentFrame(required(socket.sent, 1));
		if (localDiff.kind !== 'sync-response') {
			throw new Error('Expected local sync response');
		}
		Y.applyUpdateV2(server, localDiff.update);
		expect(server.get('content').toString()).toContain('local');

		const sentBeforeRemoteUpdate = socket.sent.length;
		socket.receive({
			kind: 'sync-response',
			update: Y.encodeStateAsUpdateV2(server, Y.encodeStateVector(doc)),
		});
		await connection.whenConnected;
		expect(connection.status).toEqual({ phase: 'connected' });
		expect(socket.sent).toHaveLength(sentBeforeRemoteUpdate);

		doc.get('content').insert(0, 'new ');
		expect(
			decodeDocumentFrame(required(socket.sent, socket.sent.length - 1)),
		).toMatchObject({
			kind: 'update',
		});
		connection.dispose();
		await connection.whenDisposed;
		doc.destroy();
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

	test('parks terminal auth, too-large, and upgrade admissions', async () => {
		for (const reason of ['auth', 'too-large', 'upgrade'] as const) {
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

	test('retries ordinary close and parks terminal too-large close', async () => {
		const scheduler = createScheduler();
		const sockets = [new FakeSocket(), new FakeSocket()];
		let opens = 0;
		const doc = new Y.Doc();
		const connection = attachDocumentConnection(doc, {
			url: 'https://api.example/document',
			openSocket: () => ({
				outcome: 'opened',
				socket: required(sockets, opens++).asWebSocket(),
			}),
			classifyClose: ({ code }) =>
				code === DOCUMENT_CLOSE_CODE['too-large']
					? { outcome: 'terminal', reason: 'too-large' }
					: { outcome: 'retry', reason: 'network' },
			schedule: scheduler.schedule,
			random: () => 0,
		});
		void connection.whenConnected.catch(() => undefined);
		await flush();
		required(sockets, 0).open();
		required(sockets, 0).serverClose(1000, 'not-live');
		expect(connection.status).toMatchObject({
			phase: 'pending',
			reason: 'network',
		});

		scheduler.runNext();
		await flush();
		required(sockets, 1).open();
		required(sockets, 1).serverClose(
			DOCUMENT_CLOSE_CODE['too-large'],
			'too-large',
		);
		expect(connection.status).toEqual({
			phase: 'terminal',
			reason: 'too-large',
		});
		expect(scheduler.tasks).toEqual([]);
		connection.dispose();
		doc.destroy();
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
