import { serveLocalWorkspaceWorker } from '@epicenter/workspace/sqlite/browser-worker';
import { workspaceDefinition } from './workspace.js';

serveLocalWorkspaceWorker(workspaceDefinition, {
	storage: { kind: 'opfs', name: 'browser-sqlite-smoke' },
	onError() {},
});
