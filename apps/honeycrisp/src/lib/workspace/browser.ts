import { storageMoved } from '@epicenter/app-shell/storage-moved';
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
}: {
	auth: WorkspaceAuth;
	onRecordsChanged(workspaceId: string): void;
}) {
	// A newer tab stealing this storage flips the app-wide blocking moved
	// state; the root layout renders <StorageMovedScreen /> in place of a
	// stale-live UI.
	const onBackgroundError = storageMoved.observe;
	const bootState = auth.state;
	if (bootState.status === 'signed-out') {
		return createDeviceBrowserWorkspaceRuntime({
			onRecordsChanged,
			onBackgroundError,
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
		onBackgroundError,
	});
}
