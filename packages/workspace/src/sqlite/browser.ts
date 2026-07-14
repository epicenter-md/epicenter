import {
	createWorkspaceWorkerPort,
	type WorkspaceWorkerPortOptions,
} from './browser-transport.js';
import {
	assertWorkspaceDefinition,
	type KvDefinitions,
	type TableDefinitions,
	type WorkspaceDefinition,
} from './definition.js';
import type {
	WorkspaceDocumentOpenerFor,
	WorkspaceDocumentRuntime,
	WorkspaceDocumentRuntimeOption,
} from './document-client.js';
import {
	type OpenedWorkspace,
	openWorkspaceFromService,
	type WorkspaceKvFor,
	type WorkspaceKvMount,
	type WorkspaceKvMountOption,
} from './open.js';

export type {
	StandaloneWorkspace,
	WorkspaceKvMount,
	WorkspaceReplica,
} from './open.js';

export type OpenStandaloneWorkspaceOptions<
	TKvMount extends WorkspaceKvMount | undefined = undefined,
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined = undefined,
> = WorkspaceWorkerPortOptions &
	WorkspaceKvMountOption<TKvMount> &
	WorkspaceDocumentRuntimeOption<TDocumentRuntime> & {
		/** Create the app-owned module Worker that imports this definition. */
		worker(): Worker;
	};

/** Open a standalone OPFS workspace through its app-owned module Worker. */
export async function openStandaloneWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TKvMount extends WorkspaceKvMount | undefined = undefined,
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined = undefined,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	options: OpenStandaloneWorkspaceOptions<TKvMount, TDocumentRuntime>,
): Promise<
	OpenedWorkspace<
		TTables,
		WorkspaceKvFor<TKvMount, TKv>,
		'standalone',
		WorkspaceDocumentOpenerFor<TDocumentRuntime>
	>
> {
	assertWorkspaceDefinition(definition);
	const { worker: createWorker } = options;
	const worker = createWorker();
	const service = createWorkspaceWorkerPort(worker, {
		startupTimeoutMs: options.startupTimeoutMs,
		disposeTimeoutMs: options.disposeTimeoutMs,
		onObserverError: options.onObserverError,
	});
	return openWorkspaceFromService<
		TTables,
		TKv,
		'standalone',
		TKvMount,
		TDocumentRuntime
	>(definition, {
		...options,
		service,
		expectedKind: 'standalone',
	});
}

export type OpenWorkspaceReplicaOptions<
	TKvMount extends WorkspaceKvMount | undefined = undefined,
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined = undefined,
> = WorkspaceWorkerPortOptions &
	WorkspaceKvMountOption<TKvMount> &
	WorkspaceDocumentRuntimeOption<TDocumentRuntime> & {
		/** Create the app-owned module Worker that imports this definition. */
		worker(): Worker;
	};

/** Open this browser storage scope's replica through its app-owned Worker. */
export async function openWorkspaceReplica<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TKvMount extends WorkspaceKvMount | undefined = undefined,
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined = undefined,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	options: OpenWorkspaceReplicaOptions<TKvMount, TDocumentRuntime>,
): Promise<
	OpenedWorkspace<
		TTables,
		WorkspaceKvFor<TKvMount, TKv>,
		'replica',
		WorkspaceDocumentOpenerFor<TDocumentRuntime>
	>
> {
	assertWorkspaceDefinition(definition);
	const { worker: createWorker } = options;
	const worker = createWorker();
	const service = createWorkspaceWorkerPort(worker, {
		startupTimeoutMs: options.startupTimeoutMs,
		disposeTimeoutMs: options.disposeTimeoutMs,
		onObserverError: options.onObserverError,
	});
	return openWorkspaceFromService<
		TTables,
		TKv,
		'replica',
		TKvMount,
		TDocumentRuntime
	>(definition, {
		...options,
		service,
		expectedKind: 'replica',
	});
}
