import type { SyncAuthClient } from '@epicenter/auth';
import { createBrowserWorkspaceRuntime } from '@epicenter/workspace/sqlite/browser';

type WorkspaceAuth = Pick<SyncAuthClient, 'state' | 'deployment' | 'fetch'>;

/** Bind Whispering's web build to its page-owned local-first runtime. */
export function createWhisperingBrowserRuntime({
	auth,
	onRecordsChanged,
}: {
	auth: WorkspaceAuth;
	onRecordsChanged(workspaceId: string): void;
}) {
	const bootState = auth.state;
	const authorityKey =
		bootState.status === 'signed-out'
			? `local:${auth.deployment.baseURL}`
			: `${auth.deployment.baseURL}\0${bootState.principalId}`;
	return createBrowserWorkspaceRuntime({
		authorityKey,
		rowSync:
			bootState.status === 'signed-out'
				? undefined
				: {
						baseUrl: auth.deployment.baseURL,
						fetch: auth.fetch,
					},
		onRecordsChanged,
	});
}
