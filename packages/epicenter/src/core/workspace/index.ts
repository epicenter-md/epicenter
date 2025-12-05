// Definition (config side)

// Provider types
export type { Provider, ProviderContext } from '../provider';
export type {
	WorkspaceClient,
	WorkspacesToClients,
} from './client';
// Runtime (client side)
export { createWorkspaceClient } from './client';
export type {
	AnyWorkspaceConfig,
	WorkspaceConfig,
	WorkspacesToExports,
} from './config';
export { defineWorkspace } from './config';
