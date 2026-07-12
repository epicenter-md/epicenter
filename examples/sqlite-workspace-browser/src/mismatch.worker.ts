import { serveStandaloneWorkspaceWorker } from '@epicenter/workspace/sqlite/browser-worker';
import { mismatchedWorkspaceDefinition } from './workspace.js';

serveStandaloneWorkspaceWorker(mismatchedWorkspaceDefinition, {
	storage: { kind: 'opfs', name: 'browser-sqlite-smoke' },
	onError() {},
});
