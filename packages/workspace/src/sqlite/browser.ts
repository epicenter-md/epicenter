import {
	createWorkspaceWorkerPort,
	type WorkspaceWorkerPortOptions,
} from './browser-transport.js';
import type {
	KvDefinitions,
	TableDefinitions,
	WorkspaceDefinition,
} from './definition.js';
import {
	openWorkspaceFromService,
	type StandaloneWorkspace,
	type WorkspaceReplica,
} from './open.js';

export type { StandaloneWorkspace, WorkspaceReplica } from './open.js';

export type OpenStandaloneWorkspaceOptions = WorkspaceWorkerPortOptions & {
	/** Create the app-owned module Worker that imports this definition. */
	worker(): Worker;
};

/** Open a standalone OPFS workspace through its app-owned module Worker. */
export async function openStandaloneWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	{ worker: createWorker, ...transportOptions }: OpenStandaloneWorkspaceOptions,
): Promise<StandaloneWorkspace<TTables, TKv>> {
	const worker = createWorker();
	const service = createWorkspaceWorkerPort(worker, transportOptions);
	return openWorkspaceFromService(definition, {
		service,
		expectedKind: 'standalone',
	});
}

export type OpenWorkspaceReplicaOptions = WorkspaceWorkerPortOptions & {
	/** Create the app-owned module Worker that imports this definition. */
	worker(): Worker;
};

/** Open this browser storage scope's replica through its app-owned Worker. */
export async function openWorkspaceReplica<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	{ worker: createWorker, ...transportOptions }: OpenWorkspaceReplicaOptions,
): Promise<WorkspaceReplica<TTables, TKv>> {
	const worker = createWorker();
	const service = createWorkspaceWorkerPort(worker, transportOptions);
	return openWorkspaceFromService(definition, {
		service,
		expectedKind: 'replica',
	});
}
