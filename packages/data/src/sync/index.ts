export {
	type AttachStoreSyncOptions,
	attachStoreSync,
	type StoreSocketTransport,
} from './attach.js';
export {
	AuthorityError,
	applyAuthoritySchema,
	type LogEntry,
	openSyncAuthority,
	type SyncAuthority,
} from './authority.js';
export {
	createSyncClient,
	type Schedule,
	type SyncClient,
	SyncClientError,
	type SyncClientStatus,
	type SyncSocket,
} from './client.js';
// Re-exported beside the status that carries it: a surface reading
// `SyncConnectionStatus.refusal` has to map the union exhaustively, and one
// import is the whole of what that costs.
export type { SyncRefusal } from '@epicenter/sync/auth-subprotocol';
export {
	createSyncConnection,
	type ReconnectReason,
	type SyncAttempt,
	type SyncConnection,
	type SyncConnectionStatus,
	type SyncDial,
} from './connection.js';
export {
	CHUNK_BYTES,
	type ChunkCollector,
	createChunkCollector,
	DO_SQLITE_VALUE_CAP,
	decodeFrame,
	encodeFrame,
	type Frame,
	FrameError,
	intoChunks,
	reassemble,
} from './frames.js';
export {
	createSyncHub,
	type HubConnection,
	type SyncHub,
} from './hub.js';
