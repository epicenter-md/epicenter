import { createHttpReplicaSyncPort } from '@epicenter/workspace/sqlite';
import { serveWorkspaceReplicaWorker } from '@epicenter/workspace/sqlite/browser-worker';
import { workspaceDefinition } from './workspace.js';

const syncOrigin = new URL(self.location.href);
syncOrigin.port = '5199';

serveWorkspaceReplicaWorker(workspaceDefinition, {
	storage: { kind: 'opfs', name: 'browser-replica-b' },
	sync: createHttpReplicaSyncPort({ baseUrl: syncOrigin.origin, fetch }),
	pollIntervalMs: 10,
	onSyncError: reportError,
	onError: reportError,
});
