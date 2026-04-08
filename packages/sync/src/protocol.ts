/**
 * Yjs WebSocket Protocol Encoding/Decoding Utilities
 *
 * Pure functions for encoding and decoding y-websocket protocol messages.
 * Separates protocol handling from transport (WebSocket handling).
 *
 * All sync payloads use Yjs V2 encoding for ~40% smaller wire size.
 * State vectors are version-independent (same format for V1 and V2).
 *
 * Based on patterns from y-redis protocol.js:
 * - Message type constants as first-class exports
 * - Pure encoder/decoder functions
 * - Single responsibility: protocol only, no transport logic
 *
 * @see https://github.com/yjs/y-redis/blob/main/src/protocol.js
 */

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { type Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';

// ============================================================================
// Top-Level Message Types
// ============================================================================

/**
 * Top-level message types in the y-websocket protocol.
 * The first varint in any message identifies its type.
 *
 * Standard y-protocols: 0–1. y-websocket conventions: 2–3.
 * Reserved 4–99 (buffer for future upstream additions).
 * Epicenter extensions: 100+.
 */
export const MESSAGE_TYPE = {
	/** Document synchronization messages (sync step 1, 2, or update) */
	SYNC: 0,
	/** User presence/cursor information */
	AWARENESS: 1,
	/** Authentication (reserved for future use) */
	AUTH: 2,
	/** Request current awareness states from server */
	QUERY_AWARENESS: 3,
	/**
	 * Version tracking for “Saving…”/“Saved” UX.
	 *
	 * NOT a heartbeat—liveness uses text ping/pong.
	 *
	 * ## How it works
	 *
	 * 1. Client increments a monotonic `localVersion` on every doc update.
	 * 2. Client sends `[100, varuint(localVersion)]` to the server.
	 * 3. Server echoes the raw payload back unchanged (zero parsing cost).
	 * 4. Client compares `ackedVersion` (from echo) to `localVersion`:
	 *    - `ackedVersion < localVersion` → `hasLocalChanges = true` (“Saving…”)
	 *    - `ackedVersion >= localVersion` → `hasLocalChanges = false` (“Saved”)
	 *
	 * ## Design (inspired by y-sweet)
	 *
	 * The server is intentionally dumb—it never parses the payload. This means
	 * the version semantics can evolve client-side without server changes.
	 *
	 * Wire format: `[varuint: 100] [varuint: localVersion]`
	 */
	SYNC_STATUS: 100,
	/**
	 * Remote procedure call between peers, routed through the DO.
	 * Uses REQUEST/RESPONSE sub-types.
	 *
	 * Wire format (REQUEST):
	 * `[varuint: 101] [varuint: 0] [varuint: requestId] [varuint: targetClientId] [varuint: requesterClientId] [varString: action] [varUint8Array: JSON input]`
	 *
	 * Wire format (RESPONSE):
	 * `[varuint: 101] [varuint: 1] [varuint: requestId] [varuint: requesterClientId] [varUint8Array: JSON { data, error }]`
	 */
	RPC: 101,
} as const;

export type MessageType = (typeof MESSAGE_TYPE)[keyof typeof MESSAGE_TYPE];

/**
 * Decodes the top-level message type from raw message data.
 *
 * The first varint in any y-websocket message is the message type:
 * - 0: MESSAGE_SYNC (document sync)
 * - 1: MESSAGE_AWARENESS (user presence)
 * - 2: MESSAGE_AUTH (authentication, reserved)
 * - 3: MESSAGE_QUERY_AWARENESS (request awareness states)
 *
 * Useful for quickly determining message type before full parsing.
 *
 * @param data - Raw message bytes
 * @returns The message type constant (0=SYNC, 1=AWARENESS, etc.)
 */
export function decodeMessageType(data: Uint8Array): number {
	const decoder = decoding.createDecoder(data);
	return decoding.readVarUint(decoder);
}

// ============================================================================
// Sync Protocol (V2 encoding)
// ============================================================================

/**
 * Sub-message types within SYNC messages.
 * Derived from y-protocols/sync constants for consistency.
 *
 * These are the second varint in a SYNC message, after MESSAGE_TYPE.SYNC.
 */
export const SYNC_MESSAGE_TYPE = {
	/** Initial handshake: "here's my state vector, what am I missing?" */
	STEP1: 0,
	/** Response to STEP1: "here are the updates you're missing" */
	STEP2: 1,
	/** Incremental document update broadcast */
	UPDATE: 2,
} as const;

export type SyncMessageType =
	(typeof SYNC_MESSAGE_TYPE)[keyof typeof SYNC_MESSAGE_TYPE];

/**
 * Decoded sync message - discriminated union of the three sync sub-types.
 * Update payloads are V2-encoded.
 */
export type DecodedSyncMessage =
	| { type: 'step1'; stateVector: Uint8Array }
	| { type: 'step2'; update: Uint8Array }
	| { type: 'update'; update: Uint8Array };

/**
 * Encodes a sync step 1 message containing the document's state vector.
 *
 * This is the first message in the Yjs sync protocol handshake. The server
 * sends its state vector to the client, asking "what updates do you have
 * that I'm missing?" The client responds with sync step 2 containing any
 * updates the server doesn't have.
 *
 * State vector encoding is version-independent (same for V1 and V2).
 *
 * @param options.doc - The Yjs document to get the state vector from
 * @returns Encoded message ready to send over WebSocket
 */
export function encodeSyncStep1({ doc }: { doc: Y.Doc }): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
		encoding.writeVarUint(encoder, SYNC_MESSAGE_TYPE.STEP1);
		encoding.writeVarUint8Array(encoder, Y.encodeStateVector(doc));
	});
}

/**
 * Encodes a sync step 2 message containing the FULL document state (V2).
 *
 * Unlike the step 2 response generated by {@link handleSyncPayload} (which
 * computes a diff against the remote's state vector), this encodes the
 * entire document with no diffing. Useful for bootstrapping a fresh client
 * that has no prior state.
 *
 * @param options.doc - The Yjs document to encode in full
 * @returns Encoded MESSAGE_SYNC + STEP2 message with full doc state
 */
export function encodeSyncStep2({ doc }: { doc: Y.Doc }): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
		encoding.writeVarUint(encoder, SYNC_MESSAGE_TYPE.STEP2);
		encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdateV2(doc));
	});
}

/**
 * Encodes a document update message for broadcasting to clients.
 *
 * After initial sync, any changes to the document are broadcast as update
 * messages. These are incremental and can be applied in any order due to
 * Yjs's CRDT properties.
 *
 * @param options.update - V2-encoded Yjs update bytes (from doc.on('updateV2'))
 * @returns Encoded message ready to send over WebSocket
 */
export function encodeSyncUpdate({
	update,
}: {
	update: Uint8Array;
}): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
		encoding.writeVarUint(encoder, SYNC_MESSAGE_TYPE.UPDATE);
		encoding.writeVarUint8Array(encoder, update);
	});
}

/**
 * Decodes a sync protocol message into its components.
 *
 * Pure decoder that returns the message type and payload without side effects.
 * Useful for testing, logging, and protocol inspection. Update payloads are
 * V2-encoded.
 *
 * @param data - Raw message bytes
 * @returns Decoded message with type discriminator and payload
 * @throws Error if message is not a valid SYNC message or has unknown sync type
 */
export function decodeSyncMessage(data: Uint8Array): DecodedSyncMessage {
	const decoder = decoding.createDecoder(data);
	const messageType = decoding.readVarUint(decoder);
	if (messageType !== MESSAGE_TYPE.SYNC) {
		throw new Error(`Expected SYNC message (0), got ${messageType}`);
	}

	const syncType = decoding.readVarUint(decoder);
	const payload = decoding.readVarUint8Array(decoder);

	switch (syncType) {
		case SYNC_MESSAGE_TYPE.STEP1:
			return { type: 'step1', stateVector: payload };
		case SYNC_MESSAGE_TYPE.STEP2:
			return { type: 'step2', update: payload };
		case SYNC_MESSAGE_TYPE.UPDATE:
			return { type: 'update', update: payload };
		default:
			throw new Error(`Unknown sync type: ${syncType}`);
	}
}

/**
 * Handle a decoded sync sub-message and return a response if needed.
 *
 * Pre-decoded alternative to y-protocols' `readSyncMessage` — accepts already-
 * decoded `syncType` and `payload` instead of a mutable lib0 decoder. The
 * caller reads these two fields from the decoder inline (consistent with how
 * AWARENESS and SYNC_STATUS cases are already handled at every call site).
 *
 * Dispatches on the three sync sub-types (all V2 encoded):
 * - STEP1: `payload` is a state vector → responds with a V2 diff (STEP2)
 * - STEP2: `payload` is a V2 update → applied to doc, no response
 * - UPDATE: `payload` is a V2 update → applied to doc, no response
 *
 * @param options.syncType - Which sync sub-message (STEP1, STEP2, or UPDATE)
 * @param options.payload - The sub-message bytes (state vector for STEP1, V2 update for STEP2/UPDATE)
 * @param options.doc - The Yjs document to sync. Mutated for STEP2/UPDATE via applyUpdateV2.
 * @param options.origin - Transaction origin passed to applyUpdateV2 (typically the connection, used to prevent echo)
 * @returns Encoded response message for STEP1, null otherwise
 */
export function handleSyncPayload({
	syncType,
	payload,
	doc,
	origin,
}: {
	syncType: SyncMessageType;
	payload: Uint8Array;
	doc: Y.Doc;
	origin: unknown;
}): Uint8Array | null {
	switch (syncType) {
		case SYNC_MESSAGE_TYPE.STEP1: {
			const diff = Y.encodeStateAsUpdateV2(doc, payload);
			return encoding.encode((encoder) => {
				encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC);
				encoding.writeVarUint(encoder, SYNC_MESSAGE_TYPE.STEP2);
				encoding.writeVarUint8Array(encoder, diff);
			});
		}
		case SYNC_MESSAGE_TYPE.STEP2:
		case SYNC_MESSAGE_TYPE.UPDATE: {
			Y.applyUpdateV2(doc, payload, origin);
			return null;
		}
		default:
			return null;
	}
}

// ============================================================================
// Awareness Protocol
// ============================================================================

/**
 * Encodes an awareness update message from raw awareness bytes.
 *
 * Awareness is used for ephemeral user presence data like cursor positions,
 * user names, and online status. Unlike document updates, awareness state
 * is not persisted and is cleared when users disconnect.
 *
 * @param options.update - Raw awareness update bytes (from encodeAwarenessUpdate)
 * @returns Encoded message ready to send over WebSocket
 */
export function encodeAwareness({
	update,
}: {
	update: Uint8Array;
}): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.AWARENESS);
		encoding.writeVarUint8Array(encoder, update);
	});
}

/**
 * Encodes awareness states for specified clients.
 *
 * Convenience function that combines awareness encoding with message wrapping.
 * Typically used to send current awareness states to newly connected clients.
 *
 * @param options.awareness - The awareness instance containing client states
 * @param options.clients - Array of client IDs whose states should be encoded
 * @returns Encoded message ready to send over WebSocket
 */
export function encodeAwarenessStates({
	awareness,
	clients,
}: {
	awareness: Awareness;
	clients: number[];
}): Uint8Array {
	return encodeAwareness({
		update: encodeAwarenessUpdate(awareness, clients),
	});
}

/**
 * Encodes a query awareness message.
 *
 * This message requests all current awareness states from the server.
 * Typically sent by clients that need to refresh their view of other users.
 *
 * @returns Encoded message ready to send over WebSocket
 */
export function encodeQueryAwareness(): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.QUERY_AWARENESS);
	});
}

// ============================================================================
// HTTP Sync Request Encoding (binary frame format for POST body)
// ============================================================================

/**
 * Encode a single-round-trip HTTP sync request body.
 *
 * Collapses the WebSocket 3-message handshake (step1 → step2 → step2) into
 * one HTTP POST/response. The client bundles its state vector and an optional
 * update together:
 *
 *   Client POST: [stateVector, update?]
 *   Server response: V2 diff the client is missing (or 304 if already in sync)
 *
 * The state vector tells the server "what I already have." The update (if
 * present) pushes local changes the server is missing. The server applies the
 * update, then diffs against the client's state vector to produce the response.
 *
 * Wire format: two length-prefixed frames (lib0 varint encoding).
 *   Frame 1: stateVector (always present)
 *   Frame 2: update (zero-length Uint8Array when absent)
 *
 * @param stateVector - Client's Yjs state vector (tells server what client has)
 * @param update - Optional V2 Yjs update to push to the server
 * @returns Encoded binary request body
 */
export function encodeSyncRequest(
	stateVector: Uint8Array,
	update?: Uint8Array,
): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint8Array(encoder, stateVector);
		encoding.writeVarUint8Array(encoder, update ?? new Uint8Array(0));
	});
}

/**
 * Decode a single-round-trip HTTP sync request body.
 *
 * Parses the two length-prefixed frames from {@link encodeSyncRequest}.
 * The update field will be an empty Uint8Array (byteLength === 0) if
 * the client had nothing to push.
 *
 * @param data - Raw sync request body bytes
 * @returns Parsed state vector and update
 * @throws Error if data is malformed or truncated
 */
export function decodeSyncRequest(data: Uint8Array): {
	stateVector: Uint8Array;
	update: Uint8Array;
} {
	const decoder = decoding.createDecoder(data);
	const stateVector = decoding.readVarUint8Array(decoder);
	const update = decoding.readVarUint8Array(decoder);
	return { stateVector, update };
}

// ============================================================================
// State Vector Utilities
// ============================================================================

/** Compare two state vectors for byte-level equality. */
export function stateVectorsEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

// ============================================================================
// SYNC_STATUS Protocol (100)
// ============================================================================

/**
 * Encode a SYNC_STATUS message with the given local version.
 *
 * Wire format: `[varuint: 100] [varuint: localVersion]`
 *
 * The server echoes this back unchanged. The client compares the echoed
 * version to its local counter to determine save state.
 *
 * @param localVersion - Monotonic counter incremented on each doc update
 * @returns Encoded SYNC_STATUS message ready to send
 */
export function encodeSyncStatus(localVersion: number): Uint8Array {
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.SYNC_STATUS);
		encoding.writeVarUint(encoder, localVersion);
	});
}

/**
 * Decode a SYNC_STATUS message, returning the local version.
 *
 * Reads past the message type varuint (100) and returns the localVersion
 * varuint. Expects the full message bytes (including the type prefix).
 *
 * @param data - Raw SYNC_STATUS message bytes
 * @returns The localVersion number from the message
 */
export function decodeSyncStatus(data: Uint8Array): number {
	const decoder = decoding.createDecoder(data);
	const messageType = decoding.readVarUint(decoder);
	if (messageType !== MESSAGE_TYPE.SYNC_STATUS) {
		throw new Error(
			`Expected SYNC_STATUS message (${MESSAGE_TYPE.SYNC_STATUS}), got ${messageType}`,
		);
	}
	return decoding.readVarUint(decoder);
}

// ============================================================================
// RPC Protocol (101)
// ============================================================================

/**
 * RPC sub-types within an RPC message.
 * The second varuint after MESSAGE_TYPE.RPC identifies the sub-type.
 */
export const RPC_TYPE = {
	/** Client → DO → target peer: invoke an action */
	REQUEST: 0,
	/** Target peer → DO → requester: action result */
	RESPONSE: 1,
} as const;

export type RpcType = (typeof RPC_TYPE)[keyof typeof RPC_TYPE];

/**
 * Decoded RPC message — discriminated union of REQUEST and RESPONSE.
 */
export type DecodedRpcMessage =
	| {
			type: 'request';
			requestId: number;
			targetClientId: number;
			requesterClientId: number;
			action: string;
			input: unknown;
	  }
	| {
			type: 'response';
			requestId: number;
			requesterClientId: number;
			result: { data: unknown; error: unknown };
	  };

/**
 * Encode an RPC REQUEST message.
 *
 * Wire format:
 * `[varuint: 101] [varuint: 0=REQUEST] [varuint: requestId] [varuint: targetClientId] [varuint: requesterClientId] [varString: action] [varUint8Array: JSON input]`
 *
 * @param options.requestId - Monotonic counter scoped to the connection
 * @param options.targetClientId - Awareness clientId of the target peer
 * @param options.requesterClientId - Awareness clientId of the sender (for response routing)
 * @param options.action - Dot-path action name (e.g. 'tabs.close')
 * @param options.input - Action input (serialized as JSON)
 * @returns Encoded RPC REQUEST message
 */
export function encodeRpcRequest({
	requestId,
	targetClientId,
	requesterClientId,
	action,
	input,
}: {
	requestId: number;
	targetClientId: number;
	requesterClientId: number;
	action: string;
	input?: unknown;
}): Uint8Array {
	const jsonBytes = new TextEncoder().encode(JSON.stringify(input ?? null));
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.RPC);
		encoding.writeVarUint(encoder, RPC_TYPE.REQUEST);
		encoding.writeVarUint(encoder, requestId);
		encoding.writeVarUint(encoder, targetClientId);
		encoding.writeVarUint(encoder, requesterClientId);
		encoding.writeVarString(encoder, action);
		encoding.writeVarUint8Array(encoder, jsonBytes);
	});
}

/**
 * Encode an RPC RESPONSE message.
 *
 * Wire format:
 * `[varuint: 101] [varuint: 1=RESPONSE] [varuint: requestId] [varuint: requesterClientId] [varUint8Array: JSON { data, error }]`
 *
 * @param options.requestId - Echo of the request's requestId
 * @param options.requesterClientId - Awareness clientId of the original requester (for DO routing)
 * @param options.result - The result envelope: `{ data, error }`
 * @returns Encoded RPC RESPONSE message
 */
export function encodeRpcResponse({
	requestId,
	requesterClientId,
	result,
}: {
	requestId: number;
	requesterClientId: number;
	result: { data: unknown; error: unknown };
}): Uint8Array {
	const jsonBytes = new TextEncoder().encode(JSON.stringify(result));
	return encoding.encode((encoder) => {
		encoding.writeVarUint(encoder, MESSAGE_TYPE.RPC);
		encoding.writeVarUint(encoder, RPC_TYPE.RESPONSE);
		encoding.writeVarUint(encoder, requestId);
		encoding.writeVarUint(encoder, requesterClientId);
		encoding.writeVarUint8Array(encoder, jsonBytes);
	});
}

/**
 * Decode an RPC message into its typed components.
 *
 * Reads the full message bytes (including the MESSAGE_TYPE.RPC prefix).
 * Returns a discriminated union of REQUEST or RESPONSE.
 *
 * Use this when you have the raw wire bytes. If the transport has already
 * consumed the message-type varint, use {@link decodeRpcPayload} instead
 * to avoid re-parsing the prefix.
 *
 * @param data - Raw RPC message bytes (starting with MESSAGE_TYPE.RPC prefix)
 * @returns Decoded RPC message with type discriminator
 */
export function decodeRpcMessage(data: Uint8Array): DecodedRpcMessage {
	const decoder = decoding.createDecoder(data);
	const messageType = decoding.readVarUint(decoder);
	if (messageType !== MESSAGE_TYPE.RPC) {
		throw new Error(
			`Expected RPC message (${MESSAGE_TYPE.RPC}), got ${messageType}`,
		);
	}

	return decodeRpcPayload(decoder);
}

/**
 * Decode an RPC payload after the message-type varint has already been consumed.
 *
 * Use this when registering a message handler for {@link MESSAGE_TYPE.RPC}—the
 * transport reads the message-type varint and passes the positioned decoder to
 * the handler, which calls this to decode the RPC sub-type and fields.
 *
 * @param decoder - A lib0 decoder positioned after the message-type varint
 * @returns Decoded RPC message with type discriminator
 */
export function decodeRpcPayload(decoder: decoding.Decoder): DecodedRpcMessage {
	const rpcType = decoding.readVarUint(decoder);

	switch (rpcType) {
		case RPC_TYPE.REQUEST: {
			const requestId = decoding.readVarUint(decoder);
			const targetClientId = decoding.readVarUint(decoder);
			const requesterClientId = decoding.readVarUint(decoder);
			const action = decoding.readVarString(decoder);
			const jsonBytes = decoding.readVarUint8Array(decoder);
			const input = JSON.parse(new TextDecoder().decode(jsonBytes));
			return {
				type: 'request',
				requestId,
				targetClientId,
				requesterClientId,
				action,
				input,
			};
		}
		case RPC_TYPE.RESPONSE: {
			const requestId = decoding.readVarUint(decoder);
			const requesterClientId = decoding.readVarUint(decoder);
			const jsonBytes = decoding.readVarUint8Array(decoder);
			const raw = JSON.parse(new TextDecoder().decode(jsonBytes));
			if (typeof raw !== 'object' || raw === null || !('data' in raw)) {
				throw new Error('Malformed RPC response: expected { data, error }');
			}
			const result = raw as { data: unknown; error: unknown };
			return { type: 'response', requestId, requesterClientId, result };
		}
		default:
			throw new Error(`Unknown RPC sub-type: ${rpcType}`);
	}
}
