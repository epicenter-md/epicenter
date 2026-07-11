import { createFileSystemBlobStore } from './file-system.tauri';
import type { BlobStore } from './types';

export type { BlobStore } from './types';
export { BlobError } from './types';

/**
 * Desktop audio lives exclusively in Epicenter's native app-data directory.
 * The browser build retains its IndexedDB-backed adapter.
 */
export const AudioBlobStoreLive =
	createFileSystemBlobStore() satisfies BlobStore;
