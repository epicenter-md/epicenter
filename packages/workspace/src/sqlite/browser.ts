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
	type OpenedWorkspace,
	openWorkspaceFromService,
	type WorkspaceKvMount,
} from './open.js';

export type {
	StandaloneWorkspace,
	WorkspaceKvMount,
	WorkspaceReplica,
} from './open.js';

export type OpenStandaloneWorkspaceOptions<
	TKvMount extends WorkspaceKvMount | undefined = undefined,
> = WorkspaceWorkerPortOptions & {
	/** Create the app-owned module Worker that imports this definition. */
	worker(): Worker;
	/** Optional preference plane composed over the caller's root Y.Doc. */
	kv?: TKvMount;
};

/** Open a standalone OPFS workspace through its app-owned module Worker. */
export async function openStandaloneWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TKvMount extends WorkspaceKvMount | undefined = undefined,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	{
		worker: createWorker,
		kv,
		...transportOptions
	}: OpenStandaloneWorkspaceOptions<TKvMount>,
): Promise<
	OpenedWorkspace<
		TTables,
		TKvMount extends WorkspaceKvMount ? TKv : undefined,
		'standalone'
	>
> {
	const worker = createWorker();
	const service = createWorkspaceWorkerPort(worker, transportOptions);
	return openWorkspaceFromService<TTables, TKv, 'standalone', TKvMount>(
		definition,
		{
			service,
			expectedKind: 'standalone',
			kv,
		},
	);
}

export type OpenWorkspaceReplicaOptions<
	TKvMount extends WorkspaceKvMount | undefined = undefined,
> = WorkspaceWorkerPortOptions & {
	/** Create the app-owned module Worker that imports this definition. */
	worker(): Worker;
	/** Optional preference plane composed over the caller's root Y.Doc. */
	kv?: TKvMount;
};

/** Open this browser storage scope's replica through its app-owned Worker. */
export async function openWorkspaceReplica<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TKvMount extends WorkspaceKvMount | undefined = undefined,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	{
		worker: createWorker,
		kv,
		...transportOptions
	}: OpenWorkspaceReplicaOptions<TKvMount>,
): Promise<
	OpenedWorkspace<
		TTables,
		TKvMount extends WorkspaceKvMount ? TKv : undefined,
		'replica'
	>
> {
	const worker = createWorker();
	const service = createWorkspaceWorkerPort(worker, transportOptions);
	return openWorkspaceFromService<TTables, TKv, 'replica', TKvMount>(
		definition,
		{
			service,
			expectedKind: 'replica',
			kv,
		},
	);
}
