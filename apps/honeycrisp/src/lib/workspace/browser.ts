import type { SyncAuthClient } from '@epicenter/auth';
import {
	createAccountBrowserWorkspaceRuntime,
	createDeviceBrowserWorkspaceRuntime,
} from '@epicenter/workspace/sqlite/browser';

type WorkspaceAuth = Pick<
	SyncAuthClient,
	'state' | 'deployment' | 'fetch' | 'openWebSocket'
>;

/** Bind Honeycrisp to the device or signed-in account selected at page boot. */
export function createHoneycrispBrowserRuntime({
	auth,
	onRecordsChanged,
	onDocumentsInvalidated,
}: {
	auth: WorkspaceAuth;
	onRecordsChanged(workspaceId: string): void;
	onDocumentsInvalidated(workspaceId: string): void;
}) {
	const bootState = auth.state;
	if (bootState.status === 'signed-out') {
		return createDeviceBrowserWorkspaceRuntime({
			onRecordsChanged,
			onDocumentsInvalidated,
		});
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
		onDocumentsInvalidated,
	});
}
