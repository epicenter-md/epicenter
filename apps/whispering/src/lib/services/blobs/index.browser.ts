import type { BlobRemote, BlobSources, BlobStore } from '@epicenter/blobs';
import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import {
	createBrowserBlobRemote,
	createEpicenterClient,
} from '@epicenter/client';
import { auth } from '#platform/auth';

const local = createBrowserBlobStore();
const epicenterClient = createEpicenterClient({
	baseURL: auth.deployment.baseURL,
	fetch: auth.fetch,
});
const remote = createBrowserBlobRemote({ local, client: epicenterClient });

/**
 * Browser composition: IndexedDB local bytes plus the hosted remote copy
 * adapter. This module owns remote availability: the capability exists only
 * while the session is signed in, so callers check one owner instead of
 * pairing a platform null with auth state.
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

export const BlobSourcesLive: BlobSources = createBrowserBlobSources(local);
