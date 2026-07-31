import type { BlobRemote, BlobSources, BlobStore } from '@epicenter/blobs';
import {
	createWebviewBlobRemote,
	createWebviewBlobSources,
	createWebviewBlobStore,
} from '@epicenter/blobs/webview';
import { auth } from '#platform/auth';

const local = createWebviewBlobStore();
const remote = createWebviewBlobRemote();

/**
 * Desktop composition: the host's canonical filesystem bytes behind the
 * authenticated WebView adapter, plus the host-streamed remote copy
 * capability. The Bun host owns the deployment credential, mints its own
 * presigned operations, and streams recording bytes between its filesystem
 * store and the remote, so nothing here ever sees a bearer or a signed URL
 * and no recording crosses WebView IPC (ADR-0149). This module owns remote
 * availability: desktop identity is immutable per process generation, so the
 * boot auth state decides whether the capability exists.
 */
export const BlobsLive: {
	local: BlobStore;
	readonly remote: BlobRemote | null;
} = {
	local,
	get remote() {
		return auth.state.status === 'signed-in' ? remote : null;
	},
};

export const BlobSourcesLive: BlobSources = createWebviewBlobSources(local);
