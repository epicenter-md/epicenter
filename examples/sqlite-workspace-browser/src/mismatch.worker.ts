import { serveLocalWorkspaceWorker } from '@epicenter/workspace/sqlite/browser-worker';
import { mismatchedWorkspaceDefinition } from './workspace.js';

serveLocalWorkspaceWorker(mismatchedWorkspaceDefinition, {
	storage: { kind: 'opfs', name: 'browser-sqlite-smoke' },
	onError() {},
});
