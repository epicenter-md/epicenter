import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import {
	createBrowserBlobRemote,
	createEpicenterClient,
} from '@epicenter/client';
import type { PrincipalId } from '@epicenter/principal';
import { auth, authClient } from '#platform/auth';
import type { WhisperingBlobs } from '$lib/whispering/app';

// The server and the authenticated fetch are boot facts, so they come off
// `authClient`: reading them through the reactive surface would track nothing
// and only suggest they change.
const epicenterClient = createEpicenterClient({
	baseURL: authClient.connection.baseURL,
	fetch: authClient.fetch,
});

/**
 * Browser composition: one account's IndexedDB bytes, the hosted remote copy
 * adapter over them, and object-URL sources for playback.
 *
 * A factory rather than a module-level value, because the local store is the
 * account's: it lives at `epicenter/v5/<app-id>/<principal-id>/blobs`
 * (ADR-0349), beside that account's replica, so it cannot exist until the
 * shell knows which account opened. Two people on one browser profile get two
 * stores, and neither can reach the other's recordings.
 *
 * This module still owns remote availability: the capability exists only
 * while the session is signed in, so callers check one owner instead of
 * pairing a platform null with auth state.
 */
export function createWhisperingBlobs({
	appId,
	principalId,
}: {
	appId: string;
	principalId: PrincipalId;
}): WhisperingBlobs {
	const local = createBrowserBlobStore({ appId, principalId });
	const remote = createBrowserBlobRemote({ local, client: epicenterClient });
	return {
		local,
		// Reactive on purpose: `signed-in` degrading to `reauth-required` does not
		// reload the page (ADR-0088), and the remote copy is exactly what stops
		// working there, so this answer has to change underneath a live app.
		get remote() {
			return auth.state.status === 'signed-in' ? remote : null;
		},
		sources: createBrowserBlobSources(local),
	};
}
