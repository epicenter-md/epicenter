/**
 * Yjs sync protocol handlers, tailored for Cloudflare Durable Objects.
 *
 * Inlined from the generic @epicenter/sync-server package. Narrowed to CF
 * WebSocket types — no framework-agnostic indirection, no WeakMap tricks.
 *
 * ## API surface
 *
 * - {@link computeInitialMessages} — pure, computes SyncStep1 + awareness states
 * - {@link registerConnection} — side-effectful, registers doc/awareness listeners
 * - {@link applyMessage} — mutates doc/awareness, returns additional effects
 * - {@link teardownConnection} — cleanup, unregisters listeners + removes awareness
 *
 * ## Error handling rationale (grounded in Yjs internals)
 *
 * `Y.applyUpdateV2` is resilient by design — it never throws on malformed
 * data. Missing dependencies are stored in `doc.store.pendingStructs` and
 * automatically retried when future updates arrive.
 *
 * However, `lib0/decoding` functions (readVarUint, readVarUint8Array) DO
 * throw on buffer underflow, and `applyAwarenessUpdate` from y-protocols
 * throws on malformed JSON. Since WebSocket messages are untrusted input,
 * `applyMessage` wraps the decode+dispatch path with `trySync` to catch
 * these at the system boundary.
 */

import {
	decodeRpcMessage,
	encodeAwareness,
	encodeAwarenessStates,
	encodeRpcResponse,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	MESSAGE_TYPE,
	RpcError,
	type SyncMessageType,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { Ok, trySync } from 'wellcrafted/result';
import {
	type Awareness,
	applyAwarenessUpdate,
	removeAwarenessStates,
} from 'y-protocols/awareness';
import type * as Y from 'yjs';

// ============================================================================
// Errors
// ============================================================================

/**
 * Errors from the sync handler layer.
 *
 * `MessageDecode` covers all failures when processing untrusted WebSocket
 * binary frames: lib0 buffer underflow (truncated messages), y-protocols
 * awareness JSON parse errors, and any other decode-time exceptions.
 */
const SyncHandlerError = defineErrors({
	MessageDecode: ({ cause }: { cause: unknown }) => ({
		message: `Failed to decode WebSocket message: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

// ============================================================================
// Types
// ============================================================================

/**
 * Shared room state — the doc and awareness instance that all connections
 * in a room share. Passed explicitly to handlers rather than duplicated
 * in every {@link Connection}.
 */
export type RoomContext = {
	doc: Y.Doc;
	awareness: Awareness;
};

/**
 * Per-connection state stored in `Map<WebSocket, Connection>`.
 *
 * Contains only per-connection data: the socket, the set of awareness
 * client IDs this connection controls, and an `unregister` closure that
 * removes the doc/awareness event listeners registered by
 * {@link registerConnection}.
 */
export type Connection = {
	ws: WebSocket;
	controlledClientIds: Set<number>;
	/** Removes `doc.on('updateV2')` and `awareness.on('update')` listeners for this connection. */
	unregister: () => void;
};

/**
 * Result of handling a single WebSocket message.
 *
 * Discriminated union on `action` — each variant maps to exactly one routing
 * pattern in the DO caller:
 *
 * - `reply`: Send data back to the sender only.
 * - `broadcast`: Fan out to all other connections, optionally persist attachment.
 * - `forward`: Route to a specific peer by clientId, with optional miss reply.
 *
 * `applyMessage` returns `Result<MessageResult | null>` — `null` means valid
 * message with no action needed (AUTH, unknown types).
 */
export type MessageResult =
	| { action: 'reply'; data: Uint8Array }
	| { action: 'broadcast'; data: Uint8Array; shouldPersistAttachment: boolean }
	| {
			action: 'forward';
			targetClientId: number;
			data: Uint8Array;
			onMissReply?: Uint8Array;
	  };

// ============================================================================
// Handlers
// ============================================================================

/**
 * Compute the initial messages to send to a newly connected client.
 *
 * Pure function — no side effects. Returns a SyncStep1 message (the room's
 * state vector) and, if any awareness states exist, the current awareness
 * snapshot. The caller sends these over the WebSocket after accepting the
 * upgrade.
 *
 * Separated from {@link registerConnection} so callers that don't need
 * initial messages (e.g. `restoreHibernated`) can skip this entirely.
 *
 * @param options.doc - The shared Yjs document
 * @param options.awareness - The shared awareness instance
 * @returns Array of encoded messages to send to the new client
 */
export function computeInitialMessages({
	doc,
	awareness,
}: RoomContext): Uint8Array[] {
	const messages: Uint8Array[] = [encodeSyncStep1({ doc })];
	const awarenessStates = awareness.getStates();
	if (awarenessStates.size > 0) {
		messages.push(
			encodeAwarenessStates({
				awareness,
				clients: Array.from(awarenessStates.keys()),
			}),
		);
	}
	return messages;
}

/**
 * Register a WebSocket connection's doc and awareness event listeners.
 *
 * Side-effectful — registers `doc.on('updateV2')` and `awareness.on('update')`
 * handlers that forward updates to the WebSocket and track controlled client
 * IDs. Returns a {@link Connection} with an `unregister` closure that removes
 * both listeners — call it via {@link teardownConnection} when the socket closes.
 *
 * @param options.doc - The shared Yjs document
 * @param options.awareness - The shared awareness instance
 * @param options.ws - The WebSocket to register listeners for
 * @returns Per-connection state with cleanup handle
 */
export function registerConnection({
	doc,
	awareness,
	ws,
}: RoomContext & { ws: WebSocket }): Connection {
	const controlledClientIds = new Set<number>();

	// Forward V2 doc updates to this connection (skip echo via identity check)
	const updateHandler = (update: Uint8Array, origin: unknown) => {
		if (origin === ws) return;
		trySync({
			try: () => ws.send(encodeSyncUpdate({ update })),
			catch: () => Ok(undefined), // connection already dead
		});
	};
	doc.on('updateV2', updateHandler);

	// Track which awareness client IDs this connection controls
	const awarenessHandler = (
		{
			added,
			updated,
			removed,
		}: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) => {
		if (origin !== ws) return;
		for (const id of added) controlledClientIds.add(id);
		for (const id of updated) controlledClientIds.add(id);
		for (const id of removed) controlledClientIds.delete(id);
	};
	awareness.on('update', awarenessHandler);

	return {
		ws,
		controlledClientIds,
		unregister() {
			doc.off('updateV2', updateHandler);
			awareness.off('update', awarenessHandler);
		},
	};
}

/**
 * Dispatch an incoming binary WebSocket message.
 *
 * Mutates `room.doc` and `room.awareness` via `applyUpdateV2` and
 * `applyAwarenessUpdate` respectively, then returns a `Result` — `Ok` with
 * a {@link MessageResult} describing what the caller should do, or
 * `Err(SyncHandlerError.MessageDecode)` if the binary frame is malformed.
 *
 * The `trySync` wrapper catches lib0 decoder throws (buffer underflow on
 * truncated messages) and y-protocols awareness errors (malformed JSON).
 * Yjs's own `applyUpdateV2` is resilient and won't throw — it stores
 * unresolved dependencies in `doc.store.pendingStructs` automatically.
 *
 * @param options.data - Raw binary WebSocket message
 * @param options.room - The shared room context (doc + awareness)
 * @param options.connection - The per-connection state (ws + controlled IDs)
 */
export function applyMessage({
	data,
	room,
	connection,
}: {
	data: Uint8Array;
	room: RoomContext;
	connection: Connection;
}) {
	return trySync({
		try: (): MessageResult | null => {
			const decoder = decoding.createDecoder(data);
			const messageType = decoding.readVarUint(decoder);

			switch (messageType) {
				case MESSAGE_TYPE.SYNC: {
					const syncType = decoding.readVarUint(decoder);
					const payload = decoding.readVarUint8Array(decoder);
					const response = handleSyncPayload({
						syncType: syncType as SyncMessageType,
						payload,
						doc: room.doc,
						origin: connection.ws,
					});
					return response ? { action: 'reply', data: response } : null;
				}

				case MESSAGE_TYPE.AWARENESS: {
					const update = decoding.readVarUint8Array(decoder);
					applyAwarenessUpdate(room.awareness, update, connection.ws);
					return {
						action: 'broadcast',
						data: encodeAwareness({ update }),
						shouldPersistAttachment: true,
					};
				}

				case MESSAGE_TYPE.QUERY_AWARENESS: {
					const awarenessStates = room.awareness.getStates();
					if (awarenessStates.size > 0) {
						return {
							action: 'reply',
							data: encodeAwarenessStates({
								awareness: room.awareness,
								clients: Array.from(awarenessStates.keys()),
							}),
						};
					}
					return null;
				}

				case MESSAGE_TYPE.SYNC_STATUS: {
					// Echo the raw message back unchanged — zero parsing cost.
					// Client uses this for version tracking ("Saving…" → "Saved").
					return { action: 'reply', data };
				}

				case MESSAGE_TYPE.RPC: {
					const rpc = decodeRpcMessage(data);
					switch (rpc.type) {
						case 'request': {
							// Prepare PeerOffline response in case target is not connected.
							// The DO will send this back to the requester if the target
							// clientId is not found in any connection's controlledClientIds.
							const onMissReply = encodeRpcResponse({
								requestId: rpc.requestId,
								requesterClientId: rpc.requesterClientId,
								result: RpcError.PeerOffline(),
							});
							return {
								action: 'forward',
								targetClientId: rpc.targetClientId,
								data,
								onMissReply,
							};
						}
						case 'response':
							// Route back to the original requester. No onMissReply —
							// if requester disconnected, silently drop.
							return {
								action: 'forward',
								targetClientId: rpc.requesterClientId,
								data,
							};
					}
				}

				case MESSAGE_TYPE.AUTH: {
					// Auth is handled at the Worker boundary (Better Auth middleware).
					// Receiving AUTH on an already-authenticated WS is unexpected —
					// log for observability but don't close the connection.
					console.warn(
						'[sync] Unexpected AUTH message on authenticated WebSocket',
					);
					return null;
				}

				default:
					console.warn(`[sync] Unknown WS message type: ${messageType}`);
					return null;
			}
		},
		catch: (cause) => SyncHandlerError.MessageDecode({ cause }),
	});
}

/**
 * Clean up a closed WebSocket connection.
 *
 * Calls `connection.unregister()` to remove the `doc.on('updateV2')` and
 * `awareness.on('update')` listeners, then removes awareness states for
 * this connection's controlled client IDs. The `removeAwarenessStates`
 * call is wrapped in `trySync` as a safety net — awareness cleanup should
 * never prevent handler deregistration from completing.
 *
 * @param options.room - The shared room context (doc + awareness)
 * @param options.connection - The per-connection state to tear down
 */
export function teardownConnection({
	room,
	connection,
}: {
	room: RoomContext;
	connection: Connection;
}): void {
	connection.unregister();

	if (connection.controlledClientIds.size > 0) {
		trySync({
			try: () =>
				removeAwarenessStates(
					room.awareness,
					Array.from(connection.controlledClientIds),
					null,
				),
			catch: () => Ok(undefined), // cleanup best-effort
		});
	}
}
