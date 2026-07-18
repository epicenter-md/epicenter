/**
 * Fixed-address Document Hub Tests
 *
 * Verifies disposable Yjs 14 hydration, atomic store admission, post-commit
 * exact-byte fanout, and socket closure without retained document state.
 *
 * Key behaviors:
 * - every connection opens one committed store snapshot and destroys its Y.Doc
 * - refused writes close every socket with an ordinary retryable close
 * - a refused over-bound candidate closes only its sender with the 1009 backstop
 */
import { describe, expect, test } from 'bun:test';
import type { RowAddress } from '@epicenter/row-sync';
import {
	DOCUMENT_BACKSTOP_CLOSE_CODE,
	type DocumentFrame,
} from '@epicenter/sync/document-v3';
import * as Y from '@y/y';
import {
	createDocumentHubCore,
	type DocumentHubSocket,
	type DocumentHubStore,
} from './core.js';

const note = { table: 'notes', rowId: 'note-a' } satisfies RowAddress;
const ordinaryClose = { code: 1000, reason: 'not-live' } as const;

describe('fixed-address document hub core', () => {
	test('closes a row that is not live without hydrating bytes', () => {
		const fixture = setup({ isLive: false });

		expect(fixture.hub.connect(fixture.alice, emptyStateVector())).toBe(false);
		expect(fixture.alice.messages).toEqual([]);
		expect(fixture.alice.closes).toEqual([ordinaryClose]);
		expect(fixture.store.opens).toBe(1);
		expect(fixture.hub.connectionCount).toBe(0);
	});

	test('opens one atomic snapshot per connection and sends missing state', () => {
		const fixture = setup({ seed: [createUpdate('persisted')] });

		expect(fixture.hub.connect(fixture.alice, emptyStateVector())).toBe(true);
		expect(fixture.hub.connect(fixture.bob, emptyStateVector())).toBe(true);

		expect(fixture.store.opens).toBe(2);
		expect(fixture.hub.connectionCount).toBe(2);
		expectDocumentContent(fixture.alice.messages, 'persisted');
		expectDocumentContent(fixture.bob.messages, 'persisted');
	});

	test('requests and persists state that existed on the client before connect', () => {
		const fixture = setup();
		const client = new Y.Doc();
		client.get('content').insert(0, 'offline');

		fixture.hub.connect(fixture.alice, Y.encodeStateVector(client));
		const request = fixture.alice.messages.find(
			(frame) => frame.kind === 'sync-request',
		);
		if (request?.kind !== 'sync-request') {
			throw new Error('Expected server sync request');
		}
		fixture.hub.receive(fixture.alice, {
			kind: 'sync-response',
			update: Y.encodeStateAsUpdateV2(client, request.stateVector),
		});

		const replayed = new Y.Doc();
		for (const update of fixture.store.updates)
			Y.applyUpdateV2(replayed, update);
		expect(replayed.get('content').toString()).toBe('offline');
	});

	test('fans out the exact appended bytes to peers only', () => {
		const fixture = setup();
		fixture.hub.connect(fixture.alice, emptyStateVector());
		fixture.hub.connect(fixture.bob, emptyStateVector());
		fixture.alice.messages.length = 0;
		fixture.bob.messages.length = 0;
		const update = createUpdate('from alice');

		fixture.hub.receive(fixture.alice, { kind: 'update', update });

		expect(fixture.store.updates).toEqual([update]);
		expect(fixture.alice.messages).toEqual([]);
		expect(fixture.bob.messages).toEqual([{ kind: 'update', update }]);
		const [broadcast] = fixture.bob.messages;
		if (broadcast?.kind !== 'update') throw new Error('Expected an update');
		expect(broadcast.update).toBe(update);
	});

	test('a refused append closes every address socket with an ordinary close', () => {
		const fixture = setup();
		fixture.hub.connect(fixture.alice, emptyStateVector());
		fixture.hub.connect(fixture.bob, emptyStateVector());
		fixture.store.beforeAppend = () => {
			fixture.store.isLive = false;
		};

		fixture.hub.receive(fixture.alice, {
			kind: 'update',
			update: createUpdate('must not persist'),
		});

		expect(fixture.store.updates).toEqual([]);
		expect(fixture.alice.closes).toEqual([ordinaryClose]);
		expect(fixture.bob.closes).toEqual([ordinaryClose]);
		expect(fixture.hub.connectionCount).toBe(0);
	});

	test('too-large closes only the sender with the 1009 backstop', () => {
		const fixture = setup();
		fixture.hub.connect(fixture.alice, emptyStateVector());
		fixture.hub.connect(fixture.bob, emptyStateVector());
		fixture.store.nextAppendResult = 'too-large';

		fixture.hub.receive(fixture.alice, {
			kind: 'update',
			update: createUpdate('oversized merged state'),
		});

		expect(fixture.alice.closes).toEqual([
			{ code: DOCUMENT_BACKSTOP_CLOSE_CODE, reason: 'too-large' },
		]);
		expect(fixture.bob.closes).toEqual([]);
		expect(fixture.hub.connectionCount).toBe(1);
	});

	test('a failed handshake send closes the socket instead of stranding it', () => {
		const fixture = setup();
		// The sync-request succeeds but the sync-response send fails: the peer
		// defers its reply until the response arrives, so the hub must fail
		// closed instead of keeping a connection it believes is live.
		let sends = 0;
		const flaky: DocumentHubSocket & {
			closes: { code: number; reason: string }[];
		} = {
			closes: [],
			send() {
				sends += 1;
				if (sends === 2) throw new Error('socket buffer gone');
			},
			close(code, reason) {
				flaky.closes.push({ code, reason });
			},
		};

		expect(fixture.hub.connect(flaky, emptyStateVector())).toBe(false);
		expect(flaky.closes).toEqual([{ code: 1000, reason: 'handshake-failed' }]);
		expect(fixture.hub.connectionCount).toBe(0);
	});

	test('never persists bytes that decode but fail store application', () => {
		const fixture = setup();
		fixture.hub.connect(fixture.alice, emptyStateVector());
		const decodedButUnapplicable = new Uint8Array([
			0, 0, 8, 147, 130, 206, 211, 175, 187, 148, 26, 0, 0, 1, 65, 15, 12, 120,
			104, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100, 1, 11, 1, 1, 0, 0,
			1, 1, 0, 0,
		]);
		expect(() => Y.decodeUpdateV2(decodedButUnapplicable)).not.toThrow();

		expect(() =>
			fixture.hub.receive(fixture.alice, {
				kind: 'update',
				update: decodedButUnapplicable,
			}),
		).toThrow();
		expect(fixture.store.updates).toEqual([]);
	});

	test('storage failure escapes without changing socket or committed state', () => {
		const fixture = setup();
		fixture.hub.connect(fixture.alice, emptyStateVector());
		fixture.store.throwNextAppend = true;

		expect(() =>
			fixture.hub.receive(fixture.alice, {
				kind: 'update',
				update: createUpdate('not committed'),
			}),
		).toThrow('storage failed');

		expect(fixture.store.updates).toEqual([]);
		expect(fixture.hub.connectionCount).toBe(1);
		fixture.hub.connect(fixture.bob, emptyStateVector());
		expectDocumentContent(fixture.bob.messages, '');
	});

	test('closeAll closes every socket without a lifetime precondition', () => {
		const fixture = setup();
		fixture.hub.connect(fixture.alice, emptyStateVector());
		fixture.hub.connect(fixture.bob, emptyStateVector());

		fixture.hub.closeAll();

		expect(fixture.alice.closes).toEqual([ordinaryClose]);
		expect(fixture.bob.closes).toEqual([ordinaryClose]);
		expect(fixture.hub.connectionCount).toBe(0);
	});

	test('a failed new admission does not infer a verdict for existing sockets', () => {
		const fixture = setup();
		fixture.hub.connect(fixture.alice, emptyStateVector());
		fixture.store.isLive = false;

		expect(fixture.hub.connect(fixture.bob, emptyStateVector())).toBe(false);
		expect(fixture.alice.closes).toEqual([]);
		expect(fixture.bob.closes).toEqual([ordinaryClose]);
		expect(fixture.hub.connectionCount).toBe(1);
	});

	test('one dead socket cannot interrupt exact-byte fanout', () => {
		const fixture = setup();
		const dead: DocumentHubSocket = {
			send() {
				throw new Error('closed');
			},
			close() {},
		};
		fixture.hub.connect(fixture.alice, emptyStateVector());
		fixture.hub.connect(dead, emptyStateVector());
		fixture.hub.connect(fixture.bob, emptyStateVector());
		fixture.bob.messages.length = 0;
		const update = createUpdate('fan out');

		fixture.hub.receive(fixture.alice, { kind: 'update', update });

		expect(fixture.bob.messages).toEqual([{ kind: 'update', update }]);
	});

	test('disconnect and restore only manage socket membership', () => {
		const fixture = setup();
		fixture.hub.restore(fixture.alice);
		expect(fixture.hub.connectionCount).toBe(1);
		expect(fixture.store.opens).toBe(0);

		expect(() => fixture.hub.restore(fixture.alice)).toThrow(
			'already connected',
		);
		fixture.hub.disconnect(fixture.alice);
		expect(fixture.hub.connectionCount).toBe(0);
	});

	test('requires a connection and refuses malformed Yjs bytes', () => {
		const fixture = setup();
		expect(() =>
			fixture.hub.receive(fixture.alice, {
				kind: 'update',
				update: createUpdate('unconnected'),
			}),
		).toThrow('active connection');

		fixture.hub.connect(fixture.alice, emptyStateVector());
		expect(() =>
			fixture.hub.receive(fixture.alice, {
				kind: 'update',
				update: new Uint8Array([255]),
			}),
		).toThrow();
		expect(fixture.store.updates).toEqual([]);
	});

	test('refuses malformed state vectors before opening the store', () => {
		const fixture = setup();

		expect(() =>
			fixture.hub.connect(fixture.alice, new Uint8Array([255])),
		).toThrow();
		expect(fixture.store.opens).toBe(0);
	});
});

function emptyStateVector(): Uint8Array {
	return Y.encodeStateVector(new Y.Doc());
}

function createUpdate(content: string): Uint8Array {
	const doc = new Y.Doc();
	doc.get('content').insert(0, content);
	return Y.encodeStateAsUpdateV2(doc);
}

function expectSyncResponse(frames: readonly DocumentFrame[]): Uint8Array {
	const frame = frames.find((candidate) => candidate.kind === 'sync-response');
	if (frame?.kind !== 'sync-response') {
		throw new Error('Expected sync response frame');
	}
	return frame.update;
}

function expectDocumentContent(
	frames: readonly DocumentFrame[],
	expected: string,
): void {
	const doc = new Y.Doc();
	Y.applyUpdateV2(doc, expectSyncResponse(frames));
	expect(doc.get('content').toString()).toBe(expected);
}

function setup({
	isLive = true,
	seed = [],
}: {
	isLive?: boolean;
	seed?: Uint8Array[];
} = {}) {
	const store = createMemoryStore(isLive, seed);
	return {
		store,
		hub: createDocumentHubCore({ address: note, store }),
		alice: createSocket(),
		bob: createSocket(),
	};
}

function createSocket(): DocumentHubSocket & {
	messages: DocumentFrame[];
	closes: { code: number; reason: string }[];
} {
	const messages: DocumentFrame[] = [];
	const closes: { code: number; reason: string }[] = [];
	return {
		messages,
		closes,
		send(frame) {
			messages.push(frame);
		},
		close(code, reason) {
			closes.push({ code, reason });
		},
	};
}

function createMemoryStore(initiallyLive: boolean, seed: Uint8Array[]) {
	type MemoryStore = DocumentHubStore & {
		opens: number;
		isLive: boolean;
		updates: Uint8Array[];
		beforeAppend: (() => void) | undefined;
		nextAppendResult: ReturnType<DocumentHubStore['appendIfLive']> | undefined;
		throwNextAppend: boolean;
	};
	const store: MemoryStore = {
		opens: 0,
		isLive: initiallyLive,
		updates: [...seed],
		beforeAppend: undefined,
		nextAppendResult: undefined,
		throwNextAppend: false,
		openIfLive(_address) {
			store.opens += 1;
			return store.isLive ? store.updates : undefined;
		},
		appendIfLive(_address, update) {
			if (store.throwNextAppend) {
				store.throwNextAppend = false;
				throw new Error('storage failed');
			}
			store.beforeAppend?.();
			const result =
				store.nextAppendResult ?? (store.isLive ? 'appended' : 'refused');
			store.nextAppendResult = undefined;
			if (result === 'appended') {
				const candidate = new Y.Doc();
				try {
					for (const committed of store.updates) {
						Y.applyUpdateV2(candidate, committed);
					}
					Y.applyUpdateV2(candidate, update);
				} finally {
					candidate.destroy();
				}
				store.updates.push(update);
			}
			return result;
		},
	};
	return store;
}
