import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const BlobError = defineErrors({
	ReadFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to read from blob store: ${extractErrorMessage(cause)}`,
		cause,
	}),
	WriteFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to write to blob store: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type BlobError = InferErrors<typeof BlobError>;

export type BlobStore = {
	save(key: string, blob: Blob): Promise<Result<void, BlobError>>;
	delete(key: string | string[]): Promise<Result<void, BlobError>>;
	clear(): Promise<Result<void, BlobError>>;

	/**
	 * Get blob by key. Fetches on-demand.
	 * - Desktop: Requests raw bytes from the id-scoped native artifact command
	 * - Web: Fetches from IndexedDB by ID, converts serialized data to Blob
	 */
	getBlob(key: string): Promise<Result<Blob, BlobError>>;

	/**
	 * Get playback URL for blob. Creates and caches URL.
	 * - Desktop and web: Creates and caches an object URL, manages lifecycle
	 */
	ensurePlaybackUrl(key: string): Promise<Result<string, BlobError>>;

	/**
	 * Revoke cached URL if present. Cleanup method.
	 * Calls URL.revokeObjectURL() and removes the cached URL.
	 */
	revokeUrl(key: string): void;
};
