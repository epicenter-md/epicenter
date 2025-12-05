import { createTaggedError, type TaggedError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

/**
 * Supported input types for blob data.
 * - Blob: Standard web API blob
 * - File: Browser File object (extends Blob)
 * - ArrayBuffer: Raw binary data
 */
export type BlobData = Blob | File | ArrayBuffer;

/**
 * Error codes for blob operations.
 */
export type BlobErrorCode =
	| 'INVALID_FILENAME'
	| 'WRITE_FAILED'
	| 'READ_FAILED'
	| 'DELETE_FAILED';

/**
 * Context for blob errors. Fixed context mode ensures every error
 * includes the filename and error code for debugging.
 */
export type BlobContext = {
	filename: string;
	code: BlobErrorCode;
};

/**
 * Error type for blob operations using wellcrafted's fixed context mode.
 *
 * Every blob error MUST include:
 * - `filename`: The filename that caused the error
 * - `code`: Error code for programmatic handling
 *
 * @example
 * ```typescript
 * return BlobErr({
 *   message: 'Invalid filename: path/to/file.txt',
 *   context: { filename: 'path/to/file.txt', code: 'INVALID_FILENAME' },
 * });
 * ```
 */
export const { BlobError, BlobErr } =
	createTaggedError<'BlobError', BlobContext>('BlobError');
export type BlobError = TaggedError<'BlobError', BlobContext>;

/**
 * Blob store for a single table namespace.
 * Provides put/get/delete/exists operations for binary files.
 */
export type TableBlobStore = {
	/**
	 * Store a blob with the given filename.
	 * @param filename Simple filename with extension (e.g., "avatar.png")
	 * @param data Binary data to store
	 */
	put(filename: string, data: BlobData): Promise<Result<void, BlobError>>;

	/**
	 * Retrieve a blob by filename.
	 * @param filename Simple filename with extension
	 * @returns The blob data, or null if not found
	 */
	get(filename: string): Promise<Result<Blob | null, BlobError>>;

	/**
	 * Delete a blob by filename.
	 * @param filename Simple filename with extension
	 */
	delete(filename: string): Promise<Result<void, BlobError>>;

	/**
	 * Check if a blob exists.
	 * @param filename Simple filename with extension
	 */
	exists(filename: string): Promise<Result<boolean, BlobError>>;
};

/**
 * Workspace blob stores, keyed by table name.
 * Automatically derived from the workspace schema.
 *
 * @example
 * ```typescript
 * // Schema: { posts: table(...), users: table(...) }
 * // Results in: { posts: TableBlobStore, users: TableBlobStore }
 *
 * await blobs.posts.put('attachment.pdf', file);
 * await blobs.users.put('avatar.png', imageData);
 * ```
 */
export type WorkspaceBlobs<TSchema extends Record<string, unknown>> = {
	[K in keyof TSchema]: TableBlobStore;
};
