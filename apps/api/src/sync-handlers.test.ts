/**
 * Sync Handler Integration Tests
 *
 * Tests the server-side Yjs sync protocol handlers that manage WebSocket
 * connections in Cloudflare Durable Objects. These handlers are the critical
 * path: if they correctly handle the sync handshake, incremental updates,
 * awareness, and cleanup, the DOs (thin wrappers around them) work.
 *
 * Key behaviors:
 * - computeInitialMessages returns SyncStep1 + awareness states
 * - registerConnection sets up doc/awareness event listeners
 * - applyMessage dispatches SYNC, AWARENESS, QUERY_AWARENESS, and SYNC_STATUS messages
 * - teardownConnection unregisters handlers and removes awareness states
 * - Multi-client broadcast: update from client A reaches client B via updateV2 handler
 * - Full handshake: SyncStep1 → SyncStep2 → documents converge
 *
 * See also:
 * - `packages/sync/src/protocol.test.ts` for protocol encode/decode unit tests
 * - `packages/sync-client/src/provider.test.ts` for client-side provider lifecycle
 */

import { describe, expect, test } from 'bun:test';
import {
	decodeMessageType,
	decodeSyncMessage,
	encodeAwareness,
	encodeQueryAwareness,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeSyncUpdate,
	MESSAGE_TYPE,
} from '@epicenter/sync';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
	applyMessage,
	computeInitialMessages,
	type RoomContext,
	registerConnection,
	teardownConnection,
} from './sync-handlers';

// ============================================================================
// Mock WebSocket
// ============================================================================

/**
 * Minimal mock of Cloudflare's WebSocket for testing sync-handlers.
 *
 * The handlers only use `.send()` (to forward updates), `.readyState`
 * (checked by DO broadcast logic, not by handlers directly), and identity
 * comparison (`origin === ws` for echo prevention).
 */
class MockWebSocket {
	sent: Uint8Array[] = [];
	readyState = 1; // WebSocket.OPEN

	send(data: Uint8Array | ArrayBuffer | string) {
		if (data instanceof Uint8Array) {
			this.sent.push(data);
		} else if (data instanceof ArrayBuffer) {
			this.sent.push(new Uint8Array(data));
		}
	}

	close() {
		this.readyState = 3; // WebSocket.CLOSED
	}
}

// ============================================================================
// Setup Helpers
// ============================================================================

/** Create a single-connection setup: room context + mock ws + connection. */
function setup(init?: (doc: Y.Doc) => void) {
	const doc = new Y.Doc();
	if (init) init(doc);
	const awareness = new Awareness(doc);
	const room: RoomContext = { doc, awareness };
	const ws = new MockWebSocket();
	const initialMessages = computeInitialMessages(room);
	const connection = registerConnection({
		...room,
		ws: ws as unknown as WebSocket,
	});
	return { doc, awareness, room, ws, connection, initialMessages };
}

/** Create a two-client setup sharing the same doc and awareness. */
function setupTwoClients(init?: (doc: Y.Doc) => void) {
	const doc = new Y.Doc();
	if (init) init(doc);
	const awareness = new Awareness(doc);
	const room: RoomContext = { doc, awareness };

	const ws1 = new MockWebSocket();
	const init1 = computeInitialMessages(room);
	const connection1 = registerConnection({
		...room,
		ws: ws1 as unknown as WebSocket,
	});

	const ws2 = new MockWebSocket();
	const init2 = computeInitialMessages(room);
	const connection2 = registerConnection({
		...room,
		ws: ws2 as unknown as WebSocket,
	});

	return {
		doc,
		awareness,
		room,
		ws1,
		connection1,
		init1,
		ws2,
		connection2,
		init2,
	};
}

// ============================================================================
// computeInitialMessages Tests
// ============================================================================

describe('computeInitialMessages', () => {
	test('returns SyncStep1 as first initial message', () => {
		const { initialMessages } = setup();

		expect(initialMessages.length).toBeGreaterThanOrEqual(1);
		// biome-ignore lint/style/noNonNullAssertion: length asserted above
		const decoded = decodeSyncMessage(initialMessages[0]!);
		expect(decoded.type).toBe('step1');
	});

	test('returns only SyncStep1 when awareness has no states', () => {
		const doc = new Y.Doc();
		const awareness = new Awareness(doc);
		// Awareness constructor sets a default local state — clear it
		awareness.setLocalState(null);

		const initialMessages = computeInitialMessages({ doc, awareness });

		expect(initialMessages).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: length asserted above
		expect(decodeMessageType(initialMessages[0]!)).toBe(MESSAGE_TYPE.SYNC);
	});

	test('returns awareness states as second message when awareness has entries', () => {
		const doc = new Y.Doc();
		const awareness = new Awareness(doc);
		awareness.setLocalState({ name: 'existing-user' });

		const initialMessages = computeInitialMessages({ doc, awareness });

		expect(initialMessages).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: length asserted above
		expect(decodeMessageType(initialMessages[0]!)).toBe(MESSAGE_TYPE.SYNC);
		// biome-ignore lint/style/noNonNullAssertion: length asserted above
		expect(decodeMessageType(initialMessages[1]!)).toBe(MESSAGE_TYPE.AWARENESS);
	});
});

// ============================================================================
// registerConnection Tests
// ============================================================================

describe('registerConnection', () => {
	test('registered updateHandler forwards doc changes to ws.send', () => {
		const { doc, ws } = setup();
		const sentBefore = ws.sent.length;

		// Change from a DIFFERENT origin (simulates another client's update being applied)
		Y.applyUpdateV2(
			doc,
			Y.encodeStateAsUpdateV2(
				createDoc((d) => d.getMap('data').set('key', 'value')),
			),
			'other-origin',
		);

		expect(ws.sent.length).toBeGreaterThan(sentBefore);
		// biome-ignore lint/style/noNonNullAssertion: length asserted above
		expect(decodeMessageType(ws.sent[ws.sent.length - 1]!)).toBe(
			MESSAGE_TYPE.SYNC,
		);
	});

	test('registered updateHandler skips echo (origin === ws)', () => {
		const { doc, ws, connection } = setup();
		const sentBefore = ws.sent.length;

		// Change from THIS connection's ws (should be skipped)
		Y.applyUpdateV2(
			doc,
			Y.encodeStateAsUpdateV2(
				createDoc((d) => d.getMap('data').set('echo', 'test')),
			),
			connection.ws, // same identity as the registered handler's ws
		);

		expect(ws.sent.length).toBe(sentBefore);
	});

	test('returns Connection with empty controlledClientIds', () => {
		const { connection } = setup();

		expect(connection.controlledClientIds).toBeInstanceOf(Set);
		expect(connection.controlledClientIds.size).toBe(0);
	});
});

// ============================================================================
// applyMessage — SYNC Tests
// ============================================================================

describe('applyMessage — SYNC', () => {
	test('SyncStep1 from client returns SyncStep2 response', () => {
		const { room, connection } = setup((d) => {
			d.getMap('data').set('server-key', 'server-value');
		});

		// Client sends its state vector (empty doc)
		const clientDoc = new Y.Doc();
		const step1Message = encodeSyncStep1({ doc: clientDoc });

		const result = applyMessage({ data: step1Message, room, connection });

		expect(result.error).toBeNull();
		expect(result.data).not.toBeNull();
		expect(result.data!.action).toBe('reply');
		if (result.data?.action === 'reply') {
			const decoded = decodeSyncMessage(result.data.data);
			expect(decoded.type).toBe('step2');
		}
	});

	test('SyncStep2 from client applies update to server doc', () => {
		const { doc, room, connection } = setup();

		// Client has content the server doesn't
		const clientDoc = createDoc((d) => {
			d.getMap('data').set('client-key', 'client-value');
		});
		const step2Message = encodeSyncStep2({ doc: clientDoc });

		const result = applyMessage({ data: step2Message, room, connection });

		expect(result.error).toBeNull();
		expect(result.data).toBeNull();
		expect(doc.getMap('data').get('client-key')).toBe('client-value');
	});

	test('SyncUpdate from client applies incremental update to server doc', () => {
		const { doc, room, connection } = setup();

		// Capture an incremental V2 update
		const sourceDoc = new Y.Doc();
		let capturedUpdate: Uint8Array | null = null;
		sourceDoc.on('updateV2', (update: Uint8Array) => {
			capturedUpdate = update;
		});
		sourceDoc.getMap('data').set('incremental', 'update-value');

		// biome-ignore lint/style/noNonNullAssertion: updateV2 handler fires synchronously from .set() above
		const updateMessage = encodeSyncUpdate({ update: capturedUpdate! });
		const result = applyMessage({ data: updateMessage, room, connection });

		expect(result.error).toBeNull();
		expect(result.data).toBeNull();
		expect(doc.getMap('data').get('incremental')).toBe('update-value');
	});
});

// ============================================================================
// applyMessage — AWARENESS Tests
// ============================================================================

describe('applyMessage — AWARENESS', () => {
	test('awareness update returns broadcast and persistAttachment effects', () => {
		const { room, connection } = setup();

		// Create a separate awareness to generate an update
		const clientDoc = new Y.Doc();
		const clientAwareness = new Awareness(clientDoc);
		clientAwareness.setLocalState({
			name: 'TestUser',
			cursor: { x: 10, y: 20 },
		});

		const update = encodeAwarenessUpdate(clientAwareness, [
			clientAwareness.clientID,
		]);
		const message = encodeAwareness({ update });

		const result = applyMessage({ data: message, room, connection });

		expect(result.error).toBeNull();
		expect(result.data).not.toBeNull();
		expect(result.data!.action).toBe('broadcast');
		if (result.data?.action === 'broadcast') {
			expect(decodeMessageType(result.data.data)).toBe(MESSAGE_TYPE.AWARENESS);
			expect(result.data.shouldPersistAttachment).toBe(true);
		}
	});

	test('awareness update is applied to the shared awareness instance', () => {
		const { room, connection, awareness } = setup();

		const clientDoc = new Y.Doc();
		const clientAwareness = new Awareness(clientDoc);
		clientAwareness.setLocalState({ name: 'Alice' });

		const update = encodeAwarenessUpdate(clientAwareness, [
			clientAwareness.clientID,
		]);
		const message = encodeAwareness({ update });

		applyMessage({ data: message, room, connection });

		const states = awareness.getStates();
		expect(states.has(clientAwareness.clientID)).toBe(true);
		expect(states.get(clientAwareness.clientID)).toEqual({ name: 'Alice' });
	});
});

// ============================================================================
// applyMessage — QUERY_AWARENESS Tests
// ============================================================================

describe('applyMessage — QUERY_AWARENESS', () => {
	test('returns awareness states when present', () => {
		const { room, connection, awareness } = setup();
		awareness.setLocalState({ name: 'ServerUser' });

		const message = encodeQueryAwareness();
		const result = applyMessage({ data: message, room, connection });

		expect(result.error).toBeNull();
		expect(result.data).not.toBeNull();
		expect(result.data!.action).toBe('reply');
		if (result.data?.action === 'reply') {
			expect(decodeMessageType(result.data.data)).toBe(MESSAGE_TYPE.AWARENESS);
		}
	});

	test('returns empty result when no awareness states exist', () => {
		const doc = new Y.Doc();
		const awareness = new Awareness(doc);
		// Clear the local state that Awareness sets by default
		awareness.setLocalState(null);

		const room: RoomContext = { doc, awareness };
		const ws = new MockWebSocket();
		const connection = registerConnection({
			...room,
			ws: ws as unknown as WebSocket,
		});

		const message = encodeQueryAwareness();
		const result = applyMessage({ data: message, room, connection });

		expect(result.error).toBeNull();
		expect(result.data).toBeNull();
	});
});

// ============================================================================
// applyMessage — Error Handling Tests
// ============================================================================

describe('applyMessage — error handling', () => {
	test('malformed binary returns MessageDecode error', () => {
		const { room, connection } = setup();

		// Garbage bytes that will cause lib0 decoder to throw
		const malformed = new Uint8Array([255, 255, 255, 255, 255]);
		const result = applyMessage({ data: malformed, room, connection });

		expect(result.error).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: error is non-null (asserted above)
		expect(result.error!.message).toContain(
			'Failed to decode WebSocket message',
		);
	});

	test('unknown message type returns empty effects (no error)', () => {
		const { room, connection } = setup();

		// Message type 99 — unknown but validly encoded
		const encoder = new Uint8Array([99]);
		const result = applyMessage({ data: encoder, room, connection });

		// Unknown types return empty effects array with no error
		expect(result.error).toBeNull();
		expect(result.data).toBeNull();
	});
});

// ============================================================================
// teardownConnection Tests
// ============================================================================

describe('teardownConnection', () => {
	test('unregisters updateV2 handler (doc mutations no longer forward to ws)', () => {
		const { doc, ws, room, connection } = setup();
		const sentBefore = ws.sent.length;

		teardownConnection({ room, connection });

		// Mutate doc from external origin — should NOT trigger ws.send
		Y.applyUpdateV2(
			doc,
			Y.encodeStateAsUpdateV2(
				createDoc((d) => d.getMap('data').set('after-close', 'value')),
			),
			'external',
		);

		expect(ws.sent.length).toBe(sentBefore);
	});

	test('removes awareness states for controlled client IDs', () => {
		const { room, connection, awareness } = setup();

		// Simulate awareness update from this connection to populate controlledClientIds
		const clientDoc = new Y.Doc();
		const clientAwareness = new Awareness(clientDoc);
		clientAwareness.setLocalState({ name: 'DisconnectingUser' });

		const update = encodeAwarenessUpdate(clientAwareness, [
			clientAwareness.clientID,
		]);
		const message = encodeAwareness({ update });
		applyMessage({ data: message, room, connection });

		// The awareness handler tracks controlled IDs when origin === ws
		// Since applyAwarenessUpdate is called with origin=connection.ws, the handler fires
		expect(awareness.getStates().has(clientAwareness.clientID)).toBe(true);

		// Manually add to controlled set (the awareness handler only tracks origin === ws)
		connection.controlledClientIds.add(clientAwareness.clientID);

		teardownConnection({ room, connection });

		expect(awareness.getStates().has(clientAwareness.clientID)).toBe(false);
	});

	test('handles close with no controlled client IDs gracefully', () => {
		const { room, connection } = setup();

		expect(connection.controlledClientIds.size).toBe(0);

		// Should not throw
		teardownConnection({ room, connection });
	});
});

// ============================================================================
// Multi-Client Broadcast Tests
// ============================================================================

describe('multi-client broadcast', () => {
	test('update from client A reaches client B via updateV2 handler', () => {
		const { room, ws1, connection1, ws2 } = setupTwoClients();

		// Clear initial messages from ws2.sent
		const ws2SentBefore = ws2.sent.length;
		const ws1SentBefore = ws1.sent.length;

		// Client A sends a sync update
		const sourceDoc = new Y.Doc();
		let capturedUpdate: Uint8Array | null = null;
		sourceDoc.on('updateV2', (update: Uint8Array) => {
			capturedUpdate = update;
		});
		sourceDoc.getMap('data').set('from-client-a', 'hello');

		// biome-ignore lint/style/noNonNullAssertion: updateV2 handler fires synchronously from .set() above
		const updateMessage = encodeSyncUpdate({ update: capturedUpdate! });
		applyMessage({ data: updateMessage, room, connection: connection1 });

		// Client B's ws should have received the forwarded update
		expect(ws2.sent.length).toBeGreaterThan(ws2SentBefore);

		// The forwarded message should be a SYNC message
		// biome-ignore lint/style/noNonNullAssertion: length asserted above
		expect(decodeMessageType(ws2.sent[ws2.sent.length - 1]!)).toBe(
			MESSAGE_TYPE.SYNC,
		);

		// Client A's ws should NOT have received it (echo prevention)
		expect(ws1.sent.length).toBe(ws1SentBefore);
	});

	test('awareness broadcast reaches other clients', () => {
		const { room, connection1, awareness } = setupTwoClients();

		// Client A sends awareness update
		const clientDoc = new Y.Doc();
		const clientAwareness = new Awareness(clientDoc);
		clientAwareness.setLocalState({ name: 'ClientA' });

		const update = encodeAwarenessUpdate(clientAwareness, [
			clientAwareness.clientID,
		]);
		const message = encodeAwareness({ update });

		const result = applyMessage({
			data: message,
			room,
			connection: connection1,
		});

		// The broadcast field should be set for the DO to distribute
		expect(result.data).not.toBeNull();
		expect(result.data!.action).toBe('broadcast');

		// The awareness state should be applied to the shared instance
		expect(awareness.getStates().has(clientAwareness.clientID)).toBe(true);
	});
});

// ============================================================================
// Full Handshake Convergence Tests
// ============================================================================

describe('full handshake convergence', () => {
	test('server content syncs to client via SyncStep1 → SyncStep2 exchange', () => {
		// Server has content
		const { room, connection, initialMessages } = setup((d) => {
			d.getMap('notes').set('note1', 'Hello from server');
			d.getArray('items').push(['item-a', 'item-b']);
		});

		// Client starts empty
		const clientDoc = new Y.Doc();

		// Step 1: Client receives server's SyncStep1 (from initialMessages)
		// biome-ignore lint/style/noNonNullAssertion: setup() always returns at least one message
		const serverStep1 = initialMessages[0]!;
		const decoded = decodeSyncMessage(serverStep1);
		expect(decoded.type).toBe('step1');

		// Step 2: Client sends its own SyncStep1 to server
		const clientStep1 = encodeSyncStep1({ doc: clientDoc });
		const result = applyMessage({ data: clientStep1, room, connection });

		expect(result.error).toBeNull();
		expect(result.data).not.toBeNull();
		expect(result.data!.action).toBe('reply');

		// Step 3: Client applies server's SyncStep2 response
		if (result.data?.action === 'reply') {
			const decodedStep2 = decodeSyncMessage(result.data.data);
			expect(decodedStep2.type).toBe('step2');
			if (decodedStep2.type === 'step2') {
				Y.applyUpdateV2(clientDoc, decodedStep2.update, 'server');
			}
		}

		// Step 4: Client sends its SyncStep2 to server (client has nothing server needs)
		const clientStep2 = encodeSyncStep2({ doc: clientDoc });
		applyMessage({ data: clientStep2, room, connection });

		// Both docs should now have identical content
		expect(clientDoc.getMap('notes').get('note1')).toBe('Hello from server');
		expect(clientDoc.getArray('items').toArray()).toEqual(['item-a', 'item-b']);
	});

	test('bidirectional sync merges content from both sides', () => {
		// Server has server-side content
		const serverDoc = new Y.Doc();
		serverDoc.getMap('data').set('server-key', 'server-value');
		const awareness = new Awareness(serverDoc);
		const room: RoomContext = { doc: serverDoc, awareness };
		const ws = new MockWebSocket();
		const connection = registerConnection({
			...room,
			ws: ws as unknown as WebSocket,
		});

		// Client has client-side content
		const clientDoc = new Y.Doc();
		clientDoc.getMap('data').set('client-key', 'client-value');

		// Client sends SyncStep1 to server → gets SyncStep2 back
		const clientStep1 = encodeSyncStep1({ doc: clientDoc });
		const result1 = applyMessage({ data: clientStep1, room, connection });
		expect(result1.data).not.toBeNull();
		expect(result1.data!.action).toBe('reply');

		// Client applies server's diff
		if (result1.data?.action === 'reply') {
			const serverDiff = decodeSyncMessage(result1.data.data);
			if (serverDiff.type === 'step2') {
				Y.applyUpdateV2(clientDoc, serverDiff.update, 'server');
			}
		}

		// Client sends its full state to server (SyncStep2)
		const clientStep2 = encodeSyncStep2({ doc: clientDoc });
		applyMessage({ data: clientStep2, room, connection });

		// Both docs should have content from both sides
		expect(serverDoc.getMap('data').get('server-key')).toBe('server-value');
		expect(serverDoc.getMap('data').get('client-key')).toBe('client-value');
		expect(clientDoc.getMap('data').get('server-key')).toBe('server-value');
		expect(clientDoc.getMap('data').get('client-key')).toBe('client-value');
	});
});

// ============================================================================
// Test Utilities (hoisted — placed at bottom for readability)
// ============================================================================

/** Create a Y.Doc with optional initial content. */
function createDoc(init?: (doc: Y.Doc) => void): Y.Doc {
	const doc = new Y.Doc();
	if (init) init(doc);
	return doc;
}
