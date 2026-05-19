/**
 * Sync handler integration tests.
 *
 * Exercises the slimmed `applyMessage` / `registerConnection` surface:
 * standard y-protocols SYNC frames, the new AWARENESS frames with
 * server-side `liveness.installationId` validation, AUTH passthrough,
 * and the connection-update broadcast wiring.
 *
 * Dispatch text-frame correlation is covered against the Durable Object
 * elsewhere (`room.dispatch` tests). This file deliberately does not
 * exercise text frames; `applyMessage` is a binary-only dispatcher.
 */

import { describe, expect, test } from 'bun:test';
import {
	encodeSyncStep1,
	encodeSyncStep2,
	encodeSyncUpdate,
	MESSAGE_TYPE,
	SYNC_MESSAGE_TYPE,
} from '@epicenter/sync';
import { expectOk } from '@epicenter/test-utils/result';
import * as encoding from 'lib0/encoding';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
	applyMessage,
	type Connection,
	encodeAwarenessFrame,
	filterAwarenessUpdate,
	type RoomContext,
	registerConnection,
} from './sync-handlers';

// ============================================================================
// Test helpers
// ============================================================================

/**
 * Minimal stand-in for a Cloudflare WebSocket. `send` captures outbound
 * frames so tests can assert on them; `readyState = 1` matches
 * `WebSocket.OPEN` so production code probing readiness is happy.
 */
class MockWebSocket {
	sent: Array<Uint8Array | string> = [];
	readyState = 1;
	send(data: Uint8Array | string): void {
		this.sent.push(data);
	}
}

function makeRoom(): RoomContext {
	const doc = new Y.Doc();
	const awareness = new Awareness(doc);
	awareness.setLocalState(null);
	return { doc, awareness, subject: 'test-user' };
}

function makeConnection(
	doc: Y.Doc,
	installationId = 'self-install',
): {
	ws: MockWebSocket;
	connection: Connection;
} {
	const ws = new MockWebSocket();
	const connection = registerConnection({
		doc,
		ws: ws as unknown as WebSocket,
		installationId,
	});
	return { ws, connection };
}

function frameSingleByte(messageType: number): Uint8Array {
	return encoding.encode((enc) => {
		encoding.writeVarUint(enc, messageType);
	});
}

/**
 * Build an awareness frame that publishes `liveness.installationId` for
 * the local client of an Awareness instance. Used to simulate what a
 * client would send on the wire.
 */
function clientAwarenessFrame({ installationId }: { installationId: string }): {
	frame: Uint8Array;
	clientID: number;
} {
	const clientDoc = new Y.Doc();
	const clientAwareness = new Awareness(clientDoc);
	clientAwareness.setLocalStateField('liveness', { installationId });
	const update = encodeAwarenessUpdate(clientAwareness, [
		clientAwareness.clientID,
	]);
	return {
		frame: encodeAwarenessFrame(update),
		clientID: clientAwareness.clientID,
	};
}

// ============================================================================
// registerConnection
// ============================================================================

describe('registerConnection', () => {
	test('forwards doc updates from other origins to the socket', () => {
		const room = makeRoom();
		const { ws } = makeConnection(room.doc);

		room.doc.transact(() => {
			room.doc.getMap('data').set('hello', 'world');
		}, 'some-other-origin');

		expect(ws.sent.length).toBe(1);
		const sent = ws.sent[0] as Uint8Array;
		expect(sent[0]).toBe(MESSAGE_TYPE.SYNC);
		expect(sent[1]).toBe(SYNC_MESSAGE_TYPE.UPDATE);
	});

	test('skips echo when origin is the connection itself', () => {
		const room = makeRoom();
		const ws = new MockWebSocket();
		const connection = registerConnection({
			doc: room.doc,
			ws: ws as unknown as WebSocket,
			installationId: 'self-install',
		});

		room.doc.transact(() => {
			room.doc.getMap('data').set('hello', 'world');
		}, connection.ws);

		expect(ws.sent.length).toBe(0);
	});

	test('unregister stops forwarding doc updates', () => {
		const room = makeRoom();
		const ws = new MockWebSocket();
		const connection = registerConnection({
			doc: room.doc,
			ws: ws as unknown as WebSocket,
			installationId: 'self-install',
		});

		room.doc.transact(() => {
			room.doc.getMap('data').set('pre', 1);
		}, 'other-origin');
		expect(ws.sent.length).toBe(1);

		connection.unregister();

		room.doc.transact(() => {
			room.doc.getMap('data').set('post', 2);
		}, 'other-origin');
		expect(ws.sent.length).toBe(1);
	});
});

// ============================================================================
// applyMessage: SYNC
// ============================================================================

describe('applyMessage SYNC STEP1', () => {
	test('replies with a STEP2 frame containing the server diff', () => {
		const room = makeRoom();
		room.doc.getMap('data').set('seed', 'value');

		const clientDoc = new Y.Doc();
		const step1 = encodeSyncStep1({ doc: clientDoc });

		const { connection } = makeConnection(room.doc);
		const effect = expectOk(
			applyMessage({
				data: step1,
				room,
				connection,
			}),
		);

		expect(effect?.action).toBe('reply');
		if (effect?.action !== 'reply') throw new Error('Expected reply effect');
		const reply = effect.data;
		expect(reply[0]).toBe(MESSAGE_TYPE.SYNC);
		expect(reply[1]).toBe(SYNC_MESSAGE_TYPE.STEP2);
	});
});

describe('applyMessage SYNC STEP2 / UPDATE', () => {
	test('STEP2 payload applies state to the target doc, no effect emitted', () => {
		const source = new Y.Doc();
		source.getMap('data').set('shared', 'yes');
		const step2 = encodeSyncStep2({ doc: source });

		const room = makeRoom();
		const { connection } = makeConnection(room.doc);

		const effect = expectOk(
			applyMessage({
				data: step2,
				room,
				connection,
			}),
		);

		expect(effect).toBeNull();
		expect(room.doc.getMap('data').get('shared')).toBe('yes');
	});

	test('UPDATE payload applies state to the target doc, no effect emitted', () => {
		const source = new Y.Doc();
		source.getMap('data').set('hello', 'world');
		const update = Y.encodeStateAsUpdateV2(source);
		const frame = encodeSyncUpdate({ update });

		const room = makeRoom();
		const { connection } = makeConnection(room.doc);

		const effect = expectOk(
			applyMessage({
				data: frame,
				room,
				connection,
			}),
		);

		expect(effect).toBeNull();
		expect(room.doc.getMap('data').get('hello')).toBe('world');
	});
});

// ============================================================================
// applyMessage: AWARENESS validation (spec §3.7, §4.4, §12)
// ============================================================================

describe('applyMessage AWARENESS', () => {
	test('valid liveness.installationId passes through to peers', () => {
		const room = makeRoom();
		const { connection } = makeConnection(room.doc, 'R_laptop');

		const { frame, clientID } = clientAwarenessFrame({
			installationId: 'R_laptop',
		});

		const effect = expectOk(
			applyMessage({
				data: frame,
				room,
				connection,
			}),
		);

		expect(effect?.action).toBe('broadcast');
		if (effect?.action !== 'broadcast') {
			throw new Error('Expected broadcast effect');
		}
		expect(effect.learnedClientIDs).toEqual([clientID]);

		// Server-side awareness reflects the peer's liveness.
		const states = room.awareness.getStates();
		expect(states.get(clientID)).toEqual({
			liveness: { installationId: 'R_laptop' },
		});
	});

	test('mismatched liveness.installationId is dropped silently', () => {
		const room = makeRoom();
		const { connection } = makeConnection(room.doc, 'R_laptop');

		const { frame, clientID } = clientAwarenessFrame({
			installationId: 'R_phone', // tries to claim a different install
		});

		const effect = expectOk(
			applyMessage({
				data: frame,
				room,
				connection,
			}),
		);

		expect(effect).toBeNull();

		// Peers never observe the bad state.
		expect(room.awareness.getStates().has(clientID)).toBe(false);
	});

	test('liveness sub-field absent: entry passes through unchanged', () => {
		// A peer publishing only `cursor` (no `liveness` claim) is fine: the
		// relay's check is on the `liveness` sub-field alone.
		const room = makeRoom();
		const { connection } = makeConnection(room.doc, 'R_laptop');

		const clientDoc = new Y.Doc();
		const clientAwareness = new Awareness(clientDoc);
		clientAwareness.setLocalStateField('cursor', { x: 1, y: 2 });
		const update = encodeAwarenessUpdate(clientAwareness, [
			clientAwareness.clientID,
		]);
		const frame = encodeAwarenessFrame(update);

		const effect = expectOk(
			applyMessage({
				data: frame,
				room,
				connection,
			}),
		);

		expect(effect?.action).toBe('broadcast');
		if (effect?.action !== 'broadcast') {
			throw new Error('Expected broadcast effect');
		}
		expect(room.awareness.getStates().get(clientAwareness.clientID)).toEqual({
			cursor: { x: 1, y: 2 },
		});
	});
});

describe('filterAwarenessUpdate', () => {
	test('returns null filtered update when every entry is dropped', () => {
		const clientDoc = new Y.Doc();
		const a = new Awareness(clientDoc);
		a.setLocalStateField('liveness', { installationId: 'bad' });
		const update = encodeAwarenessUpdate(a, [a.clientID]);

		const { filtered, clientIDs } = filterAwarenessUpdate({
			update,
			expectedInstallationId: 'expected',
		});

		expect(filtered).toBeNull();
		expect(clientIDs).toEqual([]);
	});
});

// ============================================================================
// AUTH and unknown message types
// ============================================================================

describe('applyMessage AUTH', () => {
	test('AUTH frame is a no-op', () => {
		const room = makeRoom();
		const { connection } = makeConnection(room.doc);

		const effect = expectOk(
			applyMessage({
				data: frameSingleByte(MESSAGE_TYPE.AUTH),
				room,
				connection,
			}),
		);

		expect(effect).toBeNull();
	});
});

describe('applyMessage unknown message type', () => {
	test('unknown top-level type is a no-op', () => {
		const room = makeRoom();
		const { connection } = makeConnection(room.doc);

		const effect = expectOk(
			applyMessage({
				data: frameSingleByte(99),
				room,
				connection,
			}),
		);

		expect(effect).toBeNull();
	});
});
