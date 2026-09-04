import type { BlobRemote, BlobSources, BlobStore } from '@epicenter/blobs';
import {
	createWebviewBlobRemote,
	createWebviewBlobSources,
	createWebviewBlobStore,
} from '@epicenter/blobs/webview';
import { authClient } from '#platform/auth';

const local = createWebviewBlobStore();

/**
 * Desktop composition: the host's canonical filesystem bytes behind the
 * authenticated WebView adapter, plus the host-streamed remote copy
 * capability. The Bun host owns the deployment credential, mints its own
 * presigned operations, and streams recording bytes between its filesystem
 * store and the remote, so nothing here ever sees a bearer or a signed URL
 * and no recording crosses WebView IPC (ADR-0149).
 *
 * This module owns remote availability, and it is decided once: desktop
 * identity is immutable per process generation, so the boot auth state is the
 * whole answer. `authClient`, not `auth`, because nothing here tracks.
 */
const remote =
	authClient.state.status === 'signed-in' ? createWebviewBlobRemote() : null;

export const BlobsLive: {
	local: BlobStore;
	readonly remote: BlobRemote | null;
} = { local, remote };

export const BlobSourcesLive: BlobSources = createWebviewBlobSources(local);
