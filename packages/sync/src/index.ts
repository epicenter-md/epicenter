/**
 * @epicenter/sync — Yjs Sync Protocol Primitives
 *
 * Encode/decode functions for the y-websocket wire protocol, plus
 * RPC error variants shared by both server and client.
 *
 * For server-side WebSocket lifecycle handlers, import from
 * `@epicenter/sync/server` instead.
 */

// Protocol (encode/decode for WS messages and HTTP sync requests)
export {
	type DecodedRpcMessage,
	decodeMessageType,
	decodeRpcMessage,
	decodeRpcPayload,
	decodeSyncMessage,
	decodeSyncRequest,
	decodeSyncStatus,
	encodeAwareness,
	encodeAwarenessStates,
	encodeQueryAwareness,
	encodeRpcRequest,
	encodeRpcResponse,
	encodeSyncRequest,
	encodeSyncStatus,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeSyncUpdate,
	handleSyncPayload,
	MESSAGE_TYPE,
	RPC_TYPE,
	SYNC_MESSAGE_TYPE,
	type SyncMessageType,
	stateVectorsEqual,
} from './protocol';

// RPC error variants and type guard (used by both server and client)
export { isRpcError, RpcError } from './rpc-errors';
