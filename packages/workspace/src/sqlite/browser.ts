import {
	createWorkspaceWorkerPort,
	type WorkspaceWorkerPortOptions,
} from './browser-transport.js';
import type {
	KvDefinitions,
	TableDefinitions,
	WorkspaceDefinition,
} from './definition.js';
import { type LocalWorkspace, openLocalWorkspaceFromService } from './open.js';

export type { LocalWorkspace } from './open.js';

export type OpenLocalWorkspaceOptions = WorkspaceWorkerPortOptions & {
	storage: {
		kind: 'opfs';
		/** Create the app-owned module Worker that imports this definition. */
		worker(): Worker;
	};
};

/** Open a local-only OPFS workspace through its app-owned module Worker. */
export async function openLocalWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	{ storage, ...transportOptions }: OpenLocalWorkspaceOptions,
): Promise<LocalWorkspace<TTables, TKv>> {
	const worker = storage.worker();
	const service = createWorkspaceWorkerPort(worker, transportOptions);
	return openLocalWorkspaceFromService(definition, { service });
}
