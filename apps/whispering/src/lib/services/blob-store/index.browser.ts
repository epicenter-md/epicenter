import type { BlobStore } from './types';
import { createIndexedDbBlobStore } from './web';

export type { BlobStore } from './types';
export { BlobError } from './types';

/**
 * Web blob store: just IndexedDB (via Dexie).
 *
 * On Tauri this is replaced by the native file-system store. Both entries
 * expose `AudioBlobStoreLive` satisfying `BlobStore` from types.ts.
 */
export const AudioBlobStoreLive =
	createIndexedDbBlobStore() satisfies BlobStore;
