import { lockWorkspace } from '@epicenter/workspace/sqlite';
import generationLock from '../../../generation-lock.json' with {
	type: 'json',
};
import { workspaceCandidate } from './workspace.js';

export const workspaceDefinition = lockWorkspace(
	workspaceCandidate,
	generationLock,
);
