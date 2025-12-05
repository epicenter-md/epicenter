import { join } from 'node:path';
import type { TableBlobStore, WorkspaceBlobs } from './types.js';

/**
 * Context passed to createWorkspaceBlobs.
 * Similar to IndexContext but without db (blobs don't need database access).
 */
export type BlobStoreContext<TSchema extends Record<string, unknown>> = {
	/** Workspace ID (used as parent directory for blob storage) */
	id: string;
	/** Workspace schema (table names become subdirectories) */
	schema: TSchema;
	/** Base storage directory (required for Node/Bun, undefined for browser) */
	storageDir: string | undefined;
};

/**
 * Check if running in a browser environment with OPFS support.
 */
function isBrowserWithOPFS(): boolean {
	return (
		typeof globalThis !== 'undefined' &&
		'navigator' in globalThis &&
		typeof (globalThis as any).navigator?.storage?.getDirectory === 'function'
	);
}

/**
 * Create a blob store for a single table.
 * Automatically detects environment:
 * - Browser (has OPFS support) → OPFS (Origin Private File System)
 * - Node/Bun (no OPFS) → Filesystem with Bun APIs
 *
 * @param tableName The table name (used as subdirectory)
 * @param storageDir The base storage directory (required for Node/Bun, ignored for browser)
 * @returns A TableBlobStore implementation
 */
export async function createTableBlobStore(
	tableName: string,
	storageDir?: string,
): Promise<TableBlobStore> {
	if (isBrowserWithOPFS()) {
		// Browser: use OPFS (Origin Private File System)
		const { createWebTableBlobStore } = await import('./web.js');
		return createWebTableBlobStore(tableName);
	}

	// Node/Bun: use filesystem
	if (!storageDir) {
		throw new Error('storageDir is required for Node/Bun blob storage');
	}
	const { createNodeTableBlobStore } = await import('./node.js');
	return createNodeTableBlobStore(storageDir, tableName);
}

/**
 * Create blob stores for all tables in a workspace schema.
 * Returns an object keyed by table name.
 *
 * @example
 * ```typescript
 * const blobs = await createWorkspaceBlobs({
 *   id: 'my-workspace',
 *   schema: {
 *     posts: table({ ... }),
 *     users: table({ ... }),
 *   },
 *   storageDir: '/path/to/storage',
 * });
 * // blobs.posts, blobs.users are now available
 *
 * await blobs.posts.put('attachment.pdf', file);
 * await blobs.users.put('avatar.png', imageData);
 * ```
 *
 * @param context.id - Workspace ID (used as parent directory)
 * @param context.schema - The workspace schema object
 * @param context.storageDir - The base storage directory (required for Node/Bun)
 * @returns WorkspaceBlobs object with stores for each table
 */
export async function createWorkspaceBlobs<
	TSchema extends Record<string, unknown>,
>(context: BlobStoreContext<TSchema>): Promise<WorkspaceBlobs<TSchema>> {
	const { id, schema, storageDir } = context;

	// For Node/Bun, construct the workspace-specific storage path
	// Storage layout: {storageDir}/{workspaceId}/{tableName}/{filename}
	const workspaceStorageDir = storageDir ? join(storageDir, id) : undefined;

	const tableNames = Object.keys(schema);
	const stores = await Promise.all(
		tableNames.map(async (tableName) => [
			tableName,
			await createTableBlobStore(tableName, workspaceStorageDir),
		]),
	);
	return Object.fromEntries(stores) as WorkspaceBlobs<TSchema>;
}

// Re-export types and error constructors
export type {
	BlobContext,
	BlobData,
	BlobError,
	BlobErrorCode,
	TableBlobStore,
	WorkspaceBlobs,
} from './types.js';
// Note: BlobStoreContext is already exported at its definition above
export { BlobErr } from './types.js';
export { validateFilename } from './utils.js';
