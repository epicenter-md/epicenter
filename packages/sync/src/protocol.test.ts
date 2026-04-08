/**
 * Protocol Unit Tests
 *
 * Tests y-websocket-compatible protocol helpers used by the server sync endpoint.
 * Coverage focuses on message encoding/decoding, compatibility with y-protocols,
 * and end-to-end synchronization behavior under common and edge conditions.
 *
 * Key behaviors:
 * - Sync and awareness frames encode/decode with expected wire formats.
 * - Handshake and incremental updates converge document state across peers.
 */

import { describe, expect, test } from 'bun:test';
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
	decodeMessageType,
	decodeRpcMessage,
	decodeSyncMessage,
	decodeSyncStatus,
	encodeAwareness,
	encodeAwarenessStates,
	encodeQueryAwareness,
	encodeRpcRequest,
	encodeRpcResponse,
	encodeSyncStatus,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeSyncUpdate,
	handleSyncPayload,
	MESSAGE_TYPE,
	RPC_TYPE,
	SYNC_MESSAGE_TYPE,
} from './protocol';
import { RpcError } from './rpc-errors';

// ============================================================================
// MESSAGE_TYPE Constants
// ============================================================================

describe('MESSAGE_TYPE constants', () => {
	test('match y-websocket protocol values', () => {
		// These values are defined by y-websocket and must not change
		expect(MESSAGE_TYPE.SYNC).toBe(0);
		expect(MESSAGE_TYPE.AWARENESS).toBe(1);
		expect(MESSAGE_TYPE.AUTH).toBe(2);
		expect(MESSAGE_TYPE.QUERY_AWARENESS).toBe(3);
	});

	test('SYNC_STATUS is 100 (custom extension for version tracking)', () => {
		expect(MESSAGE_TYPE.SYNC_STATUS).toBe(100);
	});
});

// ============================================================================
// SYNC_STATUS Encode/Decode Tests
// ============================================================================

describe('SYNC_STATUS encode/decode', () => {
	test('encodeSyncStatus produces correct message type', () => {
		const message = encodeSyncStatus(42);
		expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.SYNC_STATUS);
	});

	test('round-trip: encode then decode preserves localVersion', () => {
		const version = 12345;
		const encoded = encodeSyncStatus(version);
		const decoded = decodeSyncStatus(encoded);
		expect(decoded).toBe(version);
	});

	test('round-trip with version 0', () => {
		const encoded = encodeSyncStatus(0);
		const decoded = decodeSyncStatus(encoded);
		expect(decoded).toBe(0);
	});

	test('round-trip with large version number', () => {
		const version = 1_000_000;
		const encoded = encodeSyncStatus(version);
		const decoded = decodeSyncStatus(encoded);
		expect(decoded).toBe(version);
	});

	test('decodeSyncStatus throws on non-SYNC_STATUS message', () => {
		const doc = createDoc();
		const syncMessage = encodeSyncStep1({ doc });
		expect(() => decodeSyncStatus(syncMessage)).toThrow(
			'Expected SYNC_STATUS message (100), got 0',
		);
	});
});

// ============================================================================
// RPC Encode/Decode Tests
// ============================================================================

describe('RPC protocol', () => {
	test('MESSAGE_TYPE.RPC is 101', () => {
		expect(MESSAGE_TYPE.RPC).toBe(101);
	});

	test('RPC_TYPE constants', () => {
		expect(RPC_TYPE.REQUEST).toBe(0);
		expect(RPC_TYPE.RESPONSE).toBe(1);
	});

	test('round-trip: encode/decode RPC REQUEST', () => {
		const encoded = encodeRpcRequest({
			requestId: 42,
			targetClientId: 100,
			requesterClientId: 200,
			action: 'tabs.close',
			input: { tabIds: [1, 2, 3] },
		});

		expect(decodeMessageType(encoded)).toBe(MESSAGE_TYPE.RPC);

		const decoded = decodeRpcMessage(encoded);
		expect(decoded.type).toBe('request');
		if (decoded.type === 'request') {
			expect(decoded.requestId).toBe(42);
			expect(decoded.targetClientId).toBe(100);
			expect(decoded.requesterClientId).toBe(200);
			expect(decoded.action).toBe('tabs.close');
			expect(decoded.input).toEqual({ tabIds: [1, 2, 3] });
		}
	});

	test('round-trip: encode/decode RPC RESPONSE', () => {
		const encoded = encodeRpcResponse({
			requestId: 42,
			requesterClientId: 200,
			result: { data: { closedCount: 3 }, error: null },
		});

		expect(decodeMessageType(encoded)).toBe(MESSAGE_TYPE.RPC);

		const decoded = decodeRpcMessage(encoded);
		expect(decoded.type).toBe('response');
		if (decoded.type === 'response') {
			expect(decoded.requestId).toBe(42);
			expect(decoded.requesterClientId).toBe(200);
			expect(decoded.result).toEqual({ data: { closedCount: 3 }, error: null });
		}
	});

	test('REQUEST with null input', () => {
		const encoded = encodeRpcRequest({
			requestId: 0,
			targetClientId: 50,
			requesterClientId: 60,
			action: 'devices.list',
		});

		const decoded = decodeRpcMessage(encoded);
		expect(decoded.type).toBe('request');
		if (decoded.type === 'request') {
			expect(decoded.input).toBeNull();
		}
	});

	test('RESPONSE with error', () => {
		const encoded = encodeRpcResponse({
			requestId: 7,
			requesterClientId: 300,
			result: RpcError.PeerOffline(),
		});

		const decoded = decodeRpcMessage(encoded);
		expect(decoded.type).toBe('response');
		if (decoded.type === 'response') {
			expect(decoded.result.data).toBeNull();
			expect(decoded.result.error).toMatchObject({
				name: 'PeerOffline',
				message: 'Target peer is not connected',
			});
		}
	});

	test('decodeRpcMessage discriminates REQUEST vs RESPONSE', () => {
		const request = encodeRpcRequest({
			requestId: 1,
			targetClientId: 10,
			requesterClientId: 20,
			action: 'test',
		});
		const response = encodeRpcResponse({
			requestId: 1,
			requesterClientId: 20,
			result: { data: 'ok', error: null },
		});

		expect(decodeRpcMessage(request).type).toBe('request');
		expect(decodeRpcMessage(response).type).toBe('response');
	});

	test('decodeRpcMessage throws on non-RPC message', () => {
		const syncMessage = encodeSyncStep1({ doc: new Y.Doc() });
		expect(() => decodeRpcMessage(syncMessage)).toThrow(
			'Expected RPC message (101), got 0',
		);
	});
});

describe('SYNC_MESSAGE_TYPE constants', () => {
	test('have expected numeric values', () => {
		expect(SYNC_MESSAGE_TYPE.STEP1).toBe(0);
		expect(SYNC_MESSAGE_TYPE.STEP2).toBe(1);
		expect(SYNC_MESSAGE_TYPE.UPDATE).toBe(2);
	});
});

// ============================================================================
// MESSAGE_SYNC Tests
// ============================================================================

describe('MESSAGE_SYNC', () => {
	describe('encodeSyncStep1', () => {
		test('encodes empty document', () => {
			const doc = createDoc();
			const message = encodeSyncStep1({ doc });
			const decoded = decodeSyncMessage(message);

			expect(decoded.type).toBe('step1');
		});

		test('encodes document with content', () => {
			const doc = createDoc((d) => {
				d.getMap('data').set('key', 'value');
			});
			const message = encodeSyncStep1({ doc });
			const decoded = decodeSyncMessage(message);

			expect(decoded.type).toBe('step1');
		});

		test('state vector changes after modification', () => {
			const doc = createDoc();
			const message1 = encodeSyncStep1({ doc });

			doc.getMap('data').set('key', 'value');
			const message2 = encodeSyncStep1({ doc });

			// Different state vectors = different messages
			expect(message1).not.toEqual(message2);
		});

		test('can be decoded by y-protocols', () => {
			const doc = createDoc((d) => {
				d.getMap('test').set('foo', 'bar');
			});
			const message = encodeSyncStep1({ doc });
			const decoded = decodeSyncMessage(message);

			expect(decoded.type).toBe('step1');
			if (decoded.type === 'step1') {
				expect(decoded.stateVector).toBeInstanceOf(Uint8Array);
				expect(decoded.stateVector.length).toBeGreaterThan(0);
			}
		});
	});

	describe('encodeSyncStep2', () => {
		test('encodes document diff', () => {
			const doc = createDoc((d) => {
				d.getMap('data').set('key', 'value');
			});
			const message = encodeSyncStep2({ doc });
			const decoded = decodeSyncMessage(message);

			expect(decoded.type).toBe('step2');
		});

		test('contains update data', () => {
			const doc = createDoc((d) => {
				d.getMap('data').set('key', 'value');
			});
			const message = encodeSyncStep2({ doc });
			const decoded = decodeSyncMessage(message);

			expect(decoded.type).toBe('step2');
			if (decoded.type === 'step2') {
				expect(decoded.update.length).toBeGreaterThan(0);
			}
		});
	});

	describe('encodeSyncUpdate', () => {
		test('encodes incremental update', () => {
			const doc = createDoc();
			let capturedUpdate: Uint8Array | null = null;

			doc.on('updateV2', (update: Uint8Array) => {
				capturedUpdate = update;
			});
			doc.getMap('data').set('key', 'value');

			expect(capturedUpdate).not.toBeNull();
			if (!capturedUpdate) {
				throw new Error('Expected captured update after document mutation');
			}
			const message = encodeSyncUpdate({ update: capturedUpdate });
			const decoded = decodeSyncMessage(message);

			expect(decoded.type).toBe('update');
		});

		test('handles empty update', () => {
			const message = encodeSyncUpdate({ update: new Uint8Array(0) });

			expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.SYNC);
		});
	});

	describe('handleSyncPayload', () => {
		test('responds to sync step 1 with sync step 2', () => {
			const serverDoc = createDoc((d) => {
				d.getMap('data').set('server', 'content');
			});
			const clientDoc = createDoc();

			const response = handleSyncPayload({
				syncType: SYNC_MESSAGE_TYPE.STEP1,
				payload: Y.encodeStateVector(clientDoc),
				doc: serverDoc,
				origin: 'test-client',
			});

			expect(response).not.toBeNull();
			if (!response) {
				throw new Error(
					'Expected sync step 2 response for sync step 1 payload',
				);
			}
			const decoded = decodeSyncMessage(response);
			expect(decoded.type).toBe('step2');
		});

		test('returns null for sync step 2 (no response needed)', () => {
			const serverDoc = createDoc();
			const clientDoc = createDoc((d) => {
				d.getMap('data').set('client', 'content');
			});

			const response = handleSyncPayload({
				syncType: SYNC_MESSAGE_TYPE.STEP2,
				payload: Y.encodeStateAsUpdateV2(clientDoc),
				doc: serverDoc,
				origin: 'test-client',
			});

			expect(response).toBeNull();
		});

		test('returns null for sync update (no response needed)', () => {
			const serverDoc = createDoc();
			const updateV2 = Y.encodeStateAsUpdateV2(
				createDoc((d) => d.getMap('data').set('key', 'value')),
			);

			const response = handleSyncPayload({
				syncType: SYNC_MESSAGE_TYPE.UPDATE,
				payload: updateV2,
				doc: serverDoc,
				origin: 'test-client',
			});

			expect(response).toBeNull();
		});

		test('applies update to document', () => {
			const serverDoc = createDoc();
			const clientDoc = createDoc((d) => {
				d.getMap('data').set('key', 'value');
			});

			handleSyncPayload({
				syncType: SYNC_MESSAGE_TYPE.UPDATE,
				payload: Y.encodeStateAsUpdateV2(clientDoc),
				doc: serverDoc,
				origin: 'test-client',
			});

			expect(serverDoc.getMap('data').get('key')).toBe('value');
		});
	});
});

// ============================================================================
// MESSAGE_AWARENESS Tests
// ============================================================================

describe('MESSAGE_AWARENESS', () => {
	describe('encodeAwarenessStates', () => {
		test('encodes single client state', () => {
			const doc = createDoc();
			const awareness = new Awareness(doc);
			awareness.setLocalState({ name: 'User 1', cursor: { x: 10, y: 20 } });

			const message = encodeAwarenessStates({
				awareness,
				clients: [awareness.clientID],
			});

			expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.AWARENESS);
		});

		test('encodes complex nested state', () => {
			const doc = createDoc();
			const awareness = new Awareness(doc);
			awareness.setLocalState({
				user: { name: 'Test', color: '#ff0000' },
				cursor: { position: { x: 100, y: 200 }, selection: [0, 10] },
				metadata: { version: 1, flags: ['active'] },
			});

			const message = encodeAwarenessStates({
				awareness,
				clients: [awareness.clientID],
			});

			expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.AWARENESS);
		});

		test('handles special characters in state', () => {
			const doc = createDoc();
			const awareness = new Awareness(doc);
			awareness.setLocalState({
				name: 'User with "quotes" and \'apostrophes\'',
				emoji: '🎉🚀',
				newlines: 'line1\nline2',
			});

			const message = encodeAwarenessStates({
				awareness,
				clients: [awareness.clientID],
			});

			expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.AWARENESS);
		});

		test('handles large awareness state', () => {
			const doc = createDoc();
			const awareness = new Awareness(doc);
			awareness.setLocalState({
				largeArray: Array(1000).fill('item'),
				largeString: 'x'.repeat(10000),
			});

			const message = encodeAwarenessStates({
				awareness,
				clients: [awareness.clientID],
			});

			expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.AWARENESS);
			expect(message.length).toBeGreaterThan(10000);
		});
	});

	describe('encodeAwareness', () => {
		test('wraps raw awareness update', () => {
			const doc = createDoc();
			const awareness = new Awareness(doc);
			awareness.setLocalState({ name: 'Test' });

			const update = encodeAwarenessUpdate(awareness, [awareness.clientID]);
			const message = encodeAwareness({ update });

			expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.AWARENESS);
		});
	});

	describe('awareness protocol compatibility', () => {
		test('encoded awareness can be applied to another instance', () => {
			const doc1 = createDoc();
			const awareness1 = new Awareness(doc1);
			awareness1.setLocalState({ name: 'User 1' });

			const doc2 = createDoc();
			const awareness2 = new Awareness(doc2);

			// Encode from awareness1
			const update = encodeAwarenessUpdate(awareness1, [awareness1.clientID]);

			// Apply to awareness2
			applyAwarenessUpdate(awareness2, update, 'remote');

			// awareness2 should have awareness1's state
			const states = awareness2.getStates();
			expect(states.has(awareness1.clientID)).toBe(true);
			expect(states.get(awareness1.clientID)).toEqual({ name: 'User 1' });
		});

		test('null state removes client (disconnect)', () => {
			const doc = createDoc();
			const awareness = new Awareness(doc);
			awareness.setLocalState({ name: 'User' });

			expect(awareness.getStates().has(awareness.clientID)).toBe(true);

			// Setting null removes the state
			awareness.setLocalState(null);

			expect(awareness.getStates().has(awareness.clientID)).toBe(false);
		});
	});
});

// ============================================================================
// MESSAGE_QUERY_AWARENESS Tests
// ============================================================================

describe('MESSAGE_QUERY_AWARENESS', () => {
	test('query awareness message is single byte', () => {
		const message = encodeQueryAwareness();

		expect(message.length).toBe(1);
		expect(message[0]).toBe(MESSAGE_TYPE.QUERY_AWARENESS);
	});
});

// ============================================================================
// Decoder Tests
// ============================================================================

describe('decodeSyncMessage', () => {
	test('decodes sync step 1 message', () => {
		const doc = createDoc((d) => d.getMap('test').set('key', 'value'));
		const encoded = encodeSyncStep1({ doc });
		const decoded = decodeSyncMessage(encoded);

		expect(decoded.type).toBe('step1');
		if (decoded.type === 'step1') {
			expect(decoded.stateVector).toBeInstanceOf(Uint8Array);
			expect(decoded.stateVector.length).toBeGreaterThan(0);
		}
	});

	test('decodes sync step 2 message', () => {
		const doc = createDoc((d) => d.getMap('test').set('key', 'value'));
		const encoded = encodeSyncStep2({ doc });
		const decoded = decodeSyncMessage(encoded);

		expect(decoded.type).toBe('step2');
		if (decoded.type === 'step2') {
			expect(decoded.update).toBeInstanceOf(Uint8Array);
			expect(decoded.update.length).toBeGreaterThan(0);
		}
	});

	test('decodes sync update message', () => {
		const doc = createDoc();
		let capturedUpdate: Uint8Array | null = null;
		doc.on('updateV2', (update: Uint8Array) => {
			capturedUpdate = update;
		});
		doc.getMap('test').set('key', 'value');

		if (!capturedUpdate) {
			throw new Error('Expected captured update after document mutation');
		}
		const encoded = encodeSyncUpdate({ update: capturedUpdate });
		const decoded = decodeSyncMessage(encoded);

		expect(decoded.type).toBe('update');
		if (decoded.type === 'update') {
			expect(decoded.update).toBeInstanceOf(Uint8Array);
		}
	});

	test('throws on non-SYNC message type', () => {
		const doc = createDoc();
		const awareness = new Awareness(doc);
		awareness.setLocalState({ name: 'Test' });
		const awarenessMessage = encodeAwarenessStates({
			awareness,
			clients: [awareness.clientID],
		});

		expect(() => decodeSyncMessage(awarenessMessage)).toThrow(
			'Expected SYNC message (0), got 1',
		);
	});

	test('roundtrip: encode then decode preserves data', () => {
		const doc = createDoc((d) => {
			d.getMap('users').set('alice', { name: 'Alice', age: 30 });
			d.getArray('items').push(['item1', 'item2']);
		});

		// Test step 1 roundtrip
		const step1 = encodeSyncStep1({ doc });
		const decodedStep1 = decodeSyncMessage(step1);
		expect(decodedStep1.type).toBe('step1');

		// Test step 2 roundtrip
		const step2 = encodeSyncStep2({ doc });
		const decodedStep2 = decodeSyncMessage(step2);
		expect(decodedStep2.type).toBe('step2');
	});
});

describe('decodeMessageType', () => {
	test('decodes SYNC message type', () => {
		const doc = createDoc();
		const message = encodeSyncStep1({ doc });
		expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.SYNC);
	});

	test('decodes AWARENESS message type', () => {
		const doc = createDoc();
		const awareness = new Awareness(doc);
		awareness.setLocalState({ name: 'Test' });
		const message = encodeAwarenessStates({
			awareness,
			clients: [awareness.clientID],
		});
		expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.AWARENESS);
	});

	test('decodes QUERY_AWARENESS message type', () => {
		const message = encodeQueryAwareness();
		expect(decodeMessageType(message)).toBe(MESSAGE_TYPE.QUERY_AWARENESS);
	});
});

// ============================================================================
// Full Sync Protocol Tests
// ============================================================================

describe('full sync protocol', () => {
	test('complete handshake syncs server content to client', () => {
		const serverDoc = createDoc((d) => {
			d.getMap('notes').set('note1', 'Hello from server');
		});
		const clientDoc = createDoc();

		// Server handles client's state vector and responds with sync step 2 (V2 update)
		const serverResponse = handleSyncPayload({
			syncType: SYNC_MESSAGE_TYPE.STEP1,
			payload: Y.encodeStateVector(clientDoc),
			doc: serverDoc,
			origin: 'client',
		});

		expect(serverResponse).not.toBeNull();
		if (!serverResponse) {
			throw new Error('Expected server sync response during handshake');
		}

		// Client applies server's V2 response
		const decoded = decodeSyncMessage(serverResponse);
		expect(decoded.type).toBe('step2');
		if (decoded.type === 'step2') {
			Y.applyUpdateV2(clientDoc, decoded.update, 'server');
		}

		// Client should have server's content
		expect(clientDoc.getMap('notes').get('note1')).toBe('Hello from server');
	});

	test('bidirectional sync merges both documents', () => {
		const doc1 = createDoc((d) => d.getMap('data').set('from1', 'value1'));
		const doc2 = createDoc((d) => d.getMap('data').set('from2', 'value2'));

		// Full bidirectional sync using Yjs V2 pattern
		syncDocs(doc1, doc2);

		expect(doc1.getMap('data').get('from1')).toBe('value1');
		expect(doc1.getMap('data').get('from2')).toBe('value2');
		expect(doc2.getMap('data').get('from1')).toBe('value1');
		expect(doc2.getMap('data').get('from2')).toBe('value2');
	});

	test('incremental updates are applied correctly', () => {
		const doc1 = createDoc();
		const doc2 = createDoc();

		// Capture V2 updates from doc1
		const updates: Uint8Array[] = [];
		doc1.on('updateV2', (update: Uint8Array) => {
			updates.push(update);
		});

		// Make changes
		doc1.getMap('data').set('key1', 'value1');
		doc1.getMap('data').set('key2', 'value2');
		doc1.getArray('list').push(['item1', 'item2']);

		// Apply V2 updates to doc2
		for (const update of updates) {
			Y.applyUpdateV2(doc2, update);
		}

		expect(doc2.getMap('data').get('key1')).toBe('value1');
		expect(doc2.getMap('data').get('key2')).toBe('value2');
		expect(doc2.getArray('list').toArray()).toEqual(['item1', 'item2']);
	});
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('edge cases', () => {
	test('handles large document (1000+ operations)', () => {
		const doc = createDoc((d) => {
			const arr = d.getArray<string>('items');
			for (let i = 0; i < 1000; i++) {
				arr.push([`item-${i}`]);
			}
		});

		// Sync step 1 contains state vector (compact), not full content
		const syncStep1 = encodeSyncStep1({ doc });
		expect(decodeSyncMessage(syncStep1).type).toBe('step1');

		// Sync step 2 contains actual document content
		const syncStep2 = encodeSyncStep2({ doc });
		expect(decodeSyncMessage(syncStep2).type).toBe('step2');
		expect(syncStep2.length).toBeGreaterThan(1000);
	});

	test('handles concurrent modifications (CRDT merge)', () => {
		const doc1 = createDoc();
		const doc2 = createDoc();

		// Both modify same key concurrently
		doc1.getMap('data').set('key', 'value1');
		doc2.getMap('data').set('key', 'value2');

		// Sync should resolve deterministically
		syncDocs(doc1, doc2);

		// Both should have same value (CRDT resolution)
		const val1 = doc1.getMap('data').get('key');
		const val2 = doc2.getMap('data').get('key');
		expect(val1).toBe(val2);
	});

	test('empty document produces valid sync step 1', () => {
		const doc = createDoc();
		const message = encodeSyncStep1({ doc });
		const decoded = decodeSyncMessage(message);

		expect(decoded.type).toBe('step1');
		if (decoded.type === 'step1') {
			// Even empty docs have a state vector (contains clientID info)
			expect(decoded.stateVector).toBeInstanceOf(Uint8Array);
		}
	});
});

// ============================================================================
// Test Utilities (hoisted - placed at bottom for readability)
// ============================================================================

/** Create a Y.Doc with optional initial content */
function createDoc(init?: (doc: Y.Doc) => void): Y.Doc {
	const doc = new Y.Doc();
	if (init) init(doc);
	return doc;
}

/** Sync two documents bidirectionally (standard Yjs test pattern, V2) */
function syncDocs(doc1: Y.Doc, doc2: Y.Doc): void {
	const state1 = Y.encodeStateAsUpdateV2(doc1);
	const state2 = Y.encodeStateAsUpdateV2(doc2);
	Y.applyUpdateV2(doc1, state2);
	Y.applyUpdateV2(doc2, state1);
}
