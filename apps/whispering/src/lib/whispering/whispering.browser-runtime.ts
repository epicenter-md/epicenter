import type { SyncAuthClient } from '@epicenter/auth';
import {
	type NodeId,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';
import {
	type CreateBrowserWorkspaceRuntimeOptions,
	createBrowserWorkspaceRuntime,
} from '@epicenter/workspace/sqlite/browser';

type WorkspaceAuth = Pick<
	SyncAuthClient,
	'state' | 'deployment' | 'fetch' | 'openWebSocket' | 'onStateChange'
>;

/** Bind Whispering's web build to its page-owned local-first runtime. */
export function createWhisperingBrowserRuntime({
	auth,
	nodeId,
	onRecordsChanged,
}: {
	auth: WorkspaceAuth;
	nodeId: NodeId;
	onRecordsChanged(workspaceId: string): void;
}) {
	const bootState = auth.state;
	const authorityKey =
		bootState.status === 'signed-out'
			? `local:${auth.deployment.baseURL}`
			: `${auth.deployment.baseURL}\0${bootState.principalId}`;
	return createBrowserWorkspaceRuntime({
		authorityKey,
		attachDocumentSync:
			bootState.status === 'signed-out'
				? undefined
				: createDocumentSync({ auth, nodeId }),
		recordSync:
			bootState.status === 'signed-out'
				? undefined
				: {
						baseUrl: auth.deployment.baseURL,
						fetch: auth.fetch,
					},
		onRecordsChanged,
	});
}

function createDocumentSync({
	auth,
	nodeId,
}: {
	auth: WorkspaceAuth;
	nodeId: NodeId;
}): NonNullable<CreateBrowserWorkspaceRuntimeOptions['attachDocumentSync']> {
	return (ydoc, storageRef) =>
		openCollaboration(ydoc, {
			url: roomWsUrl({
				baseURL: auth.deployment.baseURL,
				guid: storageRef,
				nodeId,
			}),
			openWebSocket: auth.openWebSocket,
			onReconnectSignal: auth.onStateChange,
		});
}
