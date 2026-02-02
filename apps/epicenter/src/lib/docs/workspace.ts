import {
	createWorkspace,
	type WorkspaceDefinition,
} from '@epicenter/hq/dynamic';
import { workspacePersistence } from './workspace-persistence';

/**
 * Create a workspace client with persistence.
 *
 * @param definition - The workspace definition (id, name, tables, kv, etc.)
 * @returns A workspace client with persistence pre-configured
 */
export function createWorkspaceClient(definition: WorkspaceDefinition) {
	return createWorkspace(definition).withExtensions({
		persistence: (ctx) => workspacePersistence(ctx),
	});
}
