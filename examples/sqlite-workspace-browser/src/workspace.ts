import { lockWorkspace } from '@epicenter/workspace/sqlite';
import generationLock from '../generation-lock.json' with { type: 'json' };
import { workspaceCandidate } from './generations/g1/workspace.js';

export const workspaceDefinition = lockWorkspace(
	workspaceCandidate,
	generationLock,
);
