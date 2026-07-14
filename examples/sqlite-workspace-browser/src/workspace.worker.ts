import { serveStandaloneWorkspaceWorker } from '@epicenter/workspace/sqlite/browser-worker';
import { workspaceDefinition } from './workspace.js';

serveStandaloneWorkspaceWorker(workspaceDefinition, {
	onError() {},
});
