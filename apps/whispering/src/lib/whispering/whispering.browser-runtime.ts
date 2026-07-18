import type { SyncAuthClient } from '@epicenter/auth';
import {
	createAccountBrowserWorkspaceRuntime,
	createDeviceBrowserWorkspaceRuntime,
} from '@epicenter/workspace/sqlite/browser';

type WorkspaceAuth = Pick<
	SyncAuthClient,
	'state' | 'deployment' | 'fetch' | 'openWebSocket'
>;

/** Bind Whispering's web build to its page-owned local-first runtime. */
export function createWhisperingBrowserRuntime({
	auth,
	onRecordsChanged,
}: {
	auth: WorkspaceAuth;
	onRecordsChanged(workspaceId: string): void;
}) {
	const bootState = auth.state;
	if (bootState.status === 'signed-out') {
		return createDeviceBrowserWorkspaceRuntime({ onRecordsChanged });
	}
	return createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: auth.deployment.baseURL,
			principalId: bootState.principalId,
			transport: {
				baseUrl: auth.deployment.baseURL,
				fetch: auth.fetch,
				openWebSocket: auth.openWebSocket,
			},
		},
		onRecordsChanged,
	});
}
