import {
	type AsyncWorkspace,
	createWorkspaceClient,
	type WorkspaceServicePort,
} from './client.js';
import type {
	KvDefinitions,
	TableDefinitions,
	WorkspaceDefinition,
} from './definition.js';

export type OwnedWorkspaceServicePort = WorkspaceServicePort & AsyncDisposable;

export type OpenLocalWorkspaceOptions = {
	/** A process-local or remote service that owns the SQLite connection. */
	service: OwnedWorkspaceServicePort;
};

export type LocalWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = AsyncWorkspace<TTables, TKv> &
	AsyncDisposable & {
		readonly kind: 'local';
	};

/**
 * Open a typed client for a local-only SQLite database service.
 *
 * The service process loads the same workspace definition itself. The opening
 * handshake prevents a UI build from talking to a worker or native host with a
 * different workspace id or logical schema.
 */
export async function openLocalWorkspaceFromService<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	{ service }: OpenLocalWorkspaceOptions,
): Promise<LocalWorkspace<TTables, TKv>> {
	try {
		const description = await service.request({ kind: 'describe' });
		if (
			description.kind !== 'workspace' ||
			description.workspaceKind !== 'local' ||
			description.workspaceId !== definition.id ||
			description.schemaIdentity !== definition.schemaIdentity
		) {
			throw new Error('Workspace service definition does not match the client');
		}
	} catch (cause) {
		try {
			await service[Symbol.asyncDispose]();
		} catch (cleanupCause) {
			const primaryMessage =
				cause instanceof Error ? cause.message : String(cause);
			throw new AggregateError(
				[cause, cleanupCause],
				`Workspace open failed: ${primaryMessage}; service cleanup also failed`,
				{ cause },
			);
		}
		throw cause;
	}

	let state: 'open' | 'disposing' | 'closed' = 'open';
	let disposePromise: Promise<void> | undefined;
	function disposedError(): Error {
		return new Error('Local workspace is disposed');
	}
	const gatedService: WorkspaceServicePort = {
		request(request) {
			if (state !== 'open') return Promise.reject(disposedError());
			return service.request(request);
		},
		observe(callback) {
			if (state !== 'open') throw disposedError();
			return service.observe((delta) => {
				if (state !== 'closed') callback(delta);
			});
		},
	};
	const client = createWorkspaceClient(definition, gatedService);
	return {
		...client,
		kind: 'local',
		async [Symbol.asyncDispose]() {
			if (disposePromise) return disposePromise;
			if (state === 'closed') return;
			state = 'disposing';
			disposePromise = Promise.resolve(service[Symbol.asyncDispose]()).finally(
				() => {
					state = 'closed';
				},
			);
			return disposePromise;
		},
	};
}
