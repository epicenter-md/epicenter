import {
	createWebviewBlobRemote,
	createWebviewBlobSources,
	createWebviewBlobStore,
} from '@epicenter/blobs/webview';
import type { PrincipalId } from '@epicenter/principal';
import { authClient } from '#platform/auth';
import type { WhisperingBlobs } from '$lib/whispering/app';

/**
 * Desktop composition: the host's canonical filesystem bytes behind the
 * authenticated WebView adapter, plus the host-streamed remote copy
 * capability. The Bun host owns the deployment credential, mints its own
 * presigned operations, and streams recording bytes between its filesystem
 * store and the remote, so nothing here ever sees a bearer or a signed URL
 * and no recording crosses WebView IPC (ADR-0149).
 *
 * The scope is accepted and, today, unused. The host still keeps one flat
 * `<root>/blobs` for every account (ADR-0349 names the target,
 * `<root>/apps/<app-id>/blobs/<principal-id>/`, as unbuilt), and it resolves
 * the caller's app and principal from the signed-in session rather than from
 * a request parameter. The signature is the browser leaf's so the shell has
 * one call to make; when the host partitions, this leaf changes and the shell
 * does not.
 *
 * This module owns remote availability, and it is decided once: desktop
 * identity is immutable per process generation, so the boot auth state is the
 * whole answer. `authClient`, not `auth`, because nothing here tracks.
 */
export function createWhisperingBlobs(_scope: {
	appId: string;
	principalId: PrincipalId;
}): WhisperingBlobs {
	const local = createWebviewBlobStore();
	const remote =
		authClient.state.status === 'signed-in' ? createWebviewBlobRemote() : null;
	return { local, remote, sources: createWebviewBlobSources(local) };
}
