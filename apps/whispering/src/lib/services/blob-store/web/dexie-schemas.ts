/**
 * IndexedDB storage types for the web blob store.
 *
 * The workspace (Yjs CRDT) owns recording metadata. IndexedDB only
 * stores audio blobs keyed by recording ID.
 */
/**
 * Serialized audio format for IndexedDB storage.
 *
 * This format is used to work around iOS Safari's limitations with storing Blob objects
 * in IndexedDB. Instead of storing the Blob directly (which can fail or become corrupted
 * on iOS), we deconstruct it into:
 * - arrayBuffer: The raw binary data
 * - blobType: The original MIME type (e.g., 'audio/webm', 'audio/wav')
 *
 * This can be reliably stored in IndexedDB on all platforms, including iOS Safari.
 * To reconstruct: new Blob([arrayBuffer], { type: blobType })
 */
export type SerializedAudio = {
	arrayBuffer: ArrayBuffer;
	blobType: string;
};

/**
 * How a recording is stored in IndexedDB (audio-only storage format).
 *
 * The workspace (Yjs CRDT) is the sole source of truth for recording metadata.
 * IndexedDB only stores the audio blob alongside the recording ID.
 *
 * Legacy rows may still carry metadata fields from older schema versions.
 * These are ignored on read. Only `id` and `serializedAudio` are used.
 */
export type AudioStoredInIndexedDB = {
	id: string;
	serializedAudio: SerializedAudio | undefined;
};
