import type { FileStore, FsSnapshot } from './fs';

/**
 * SyncEngine: Git-oriented engine used by VaultService.
 * - Provides a FileStore view of the working tree
 * - Performs VCS operations (pull/commit/push)
 * Glue logic (DB<->files via formats/conventions) is handled in VaultService.
 */
export interface SyncEngine {
	/** Return a FileStore rooted at the sync workspace (e.g., repo dir). */
	getStore(): Promise<FileStore>;
	/** Ensure local workspace is up-to-date; return snapshot after pull. */
	pull(): Promise<FsSnapshot>;
	/** Stage and commit current workspace changes with a message. */
	commit(message: string): Promise<void>;
	/** Push committed changes to remote. */
	push(): Promise<void>;
}
