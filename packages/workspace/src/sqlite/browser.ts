import {
	type LocalWorkspaceInspection,
	parseWorkspaceInspectionEvent,
	type WorkspaceInspectionEvent,
} from './browser-inspection.js';
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

export type { LocalWorkspaceInspection } from './browser-inspection.js';
export type {
	StandaloneWorkspace,
	WorkspaceKvMount,
	WorkspaceReplica,
} from './open.js';

export type InspectLocalWorkspaceOptions = {
	/** Create the app-owned inspector Worker that imports this definition. */
	worker(): Worker;
	timeoutMs?: number;
};

/** Inspect one locked OPFS namespace without creating or initializing it. */
export function inspectLocalWorkspace(
	definition: WorkspaceDefinition,
	{ worker: createWorker, timeoutMs = 10_000 }: InspectLocalWorkspaceOptions,
): Promise<LocalWorkspaceInspection> {
	assertWorkspaceDefinition(definition);
	const worker = createWorker();
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		function cleanup(): void {
			if (timer) clearTimeout(timer);
			worker.removeEventListener('message', onMessage);
			worker.removeEventListener('error', onError);
			worker.removeEventListener('messageerror', onMessageError);
			worker.terminate();
		}
		function fail(error: Error): void {
			cleanup();
			reject(error);
		}
		function onMessage(event: MessageEvent<unknown>): void {
			let message: WorkspaceInspectionEvent;
			try {
				message = parseWorkspaceInspectionEvent(event.data);
			} catch (cause) {
				fail(
					new Error('Workspace inspector sent an invalid protocol message', {
						cause,
					}),
				);
				return;
			}
			if (message.type === 'error') {
				const error = new Error(message.error.message);
				error.name = message.error.name;
				fail(error);
				return;
			}
			if (
				message.workspaceId !== definition.workspaceId ||
				message.recordsDescriptor !== definition.recordsDescriptor ||
				message.recordsSchemaHash !== definition.recordsSchemaHash
			) {
				fail(
					new Error('Workspace inspector definition does not match the client'),
				);
				return;
			}
			cleanup();
			resolve(message.inspection);
		}
		function onError(event: ErrorEvent): void {
			fail(new Error(event.message || 'Workspace inspector crashed'));
		}
		function onMessageError(): void {
			fail(new Error('Workspace inspector response could not be deserialized'));
		}

		worker.addEventListener('message', onMessage);
		worker.addEventListener('error', onError);
		worker.addEventListener('messageerror', onMessageError);
		if (timeoutMs > 0) {
			timer = setTimeout(
				() => fail(new Error('Workspace inspector timed out')),
				timeoutMs,
			);
		}
	});
}

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
