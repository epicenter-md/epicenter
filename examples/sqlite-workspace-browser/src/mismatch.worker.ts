import { lockWorkspace } from '@epicenter/workspace/sqlite';
import { serveStandaloneWorkspaceWorker } from '@epicenter/workspace/sqlite/browser-worker';
import generationLock from '../generation-lock.json' with { type: 'json' };
import { workspaceCandidate } from './generations/g2/workspace.js';

serveStandaloneWorkspaceWorker(
	lockWorkspace(workspaceCandidate, generationLock),
	{
		onError() {},
	},
);
