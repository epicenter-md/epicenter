import type { BlobRemote, BlobSources, BlobStore } from '@epicenter/blobs';
import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import {
	createBrowserBlobRemote,
	createEpicenterClient,
} from '@epicenter/client';
import { auth, authClient } from '#platform/auth';

const local = createBrowserBlobStore();
// The server and the authenticated fetch are boot facts, so they come off
// `authClient`: reading them through the reactive surface would track nothing
// and only suggest they change.
const epicenterClient = createEpicenterClient({
	baseURL: authClient.connection.baseURL,
	fetch: authClient.fetch,
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
	// Reactive on purpose: `signed-in` degrading to `reauth-required` does not
	// reload the page (ADR-0088), and the remote copy is exactly what stops
	// working there, so this answer has to change underneath a live app.
	get remote() {
		return auth.state.status === 'signed-in' ? remote : null;
	},
};

export const BlobSourcesLive: BlobSources = createBrowserBlobSources(local);
