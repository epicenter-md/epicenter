import type { BlobRemote, BlobSources, BlobStore } from '@epicenter/blobs';
import {
	createWebviewBlobSources,
	createWebviewBlobStore,
} from '@epicenter/blobs/webview';

const local = createWebviewBlobStore();

/**
 * Desktop composition: the host's canonical filesystem bytes behind the
 * authenticated WebView adapter. The remote capability is host-streaming by
 * doctrine (a whole recording must never cross WebView IPC), and a
 * host-streamed remote needs the Bun host to mint its own presigned
 * operations against the selected deployment. Today the WebView owns
 * deployment selection and the OAuth grant, so the host has no credential
 * authority to mint with; desktop remote stays absent until that authority
 * moves into the host, rather than shipping a WebView-presigned bridge whose
 * routes would accept caller-supplied destination URLs.
 */
export const BlobsLive: {
	local: BlobStore;
	readonly remote: BlobRemote | null;
} = {
	local,
	remote: null,
};

export const BlobSourcesLive: BlobSources = createWebviewBlobSources(local);
