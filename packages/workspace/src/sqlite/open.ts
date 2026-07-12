import type * as Y from 'yjs';
import { KV_KEY } from '../document/keys.js';
import { createKv, type Kv, type KvDefinitions } from '../document/kv.js';
import {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from '../document/y-keyvalue/index.js';
import {
	type AsyncWorkspace,
	createWorkspaceClient,
	type WorkspaceServicePort,
} from './client.js';
import type { TableDefinitions, WorkspaceDefinition } from './definition.js';

export type OwnedWorkspaceServicePort = WorkspaceServicePort & AsyncDisposable;

/**
 * The preference plane the caller composes into an opened workspace.
 *
 * The record database is table-only (ADR-0124); declared KV lives on the
 * eager root Yjs document. The caller owns the document and its persistence;
 * the opener only mounts the typed KV handle over it.
 */
export type WorkspaceKvMount = {
	/** Eager root document that carries the workspace's kv namespace. */
	doc: Y.Doc;
	/**
	 * Resolves once local persistence has hydrated `doc`. Awaited before the
	 * workspace opens: absence must not be treated as the durable default
	 * until local hydration finished.
	 */
	whenHydrated?: Promise<unknown>;
};

type OpenWorkspaceFromServiceOptions<
	TKind extends 'standalone' | 'replica',
	TKvMount extends WorkspaceKvMount | undefined = undefined,
> = {
	/** A process-local or remote service that owns the SQLite connection. */
	service: OwnedWorkspaceServicePort;
	expectedKind: TKind;
	/** Optional preference plane; omitted means a table-only workspace. */
	kv?: TKvMount;
};

/**
 * An opened workspace: async record tables behind their service boundary,
 * plus, when the caller composed one, a synchronous `kv` preference handle
 * over the eager root document. Table-only callers get `kv: undefined` and
 * pay nothing.
 */
export type OpenedWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions | undefined,
	TKind extends 'standalone' | 'replica',
> = AsyncWorkspace<TTables> &
	AsyncDisposable & {
		readonly kind: TKind;
		readonly kv: TKv extends KvDefinitions ? Kv<TKv> : undefined;
	};

export type StandaloneWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions | undefined = undefined,
> = OpenedWorkspace<TTables, TKv, 'standalone'>;

export type WorkspaceReplica<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions | undefined = undefined,
> = OpenedWorkspace<TTables, TKv, 'replica'>;

/**
 * Open a typed client for a SQLite database service.
 *
 * The service process loads the same workspace definition itself. The opening
 * handshake prevents a UI build from talking to a worker or native host with a
 * different workspace id or logical schema.
 *
 * When `kv` is provided, the returned workspace also mounts the preference
 * plane: `whenHydrated` is awaited before returning, then a `YKeyValueLww`
 * store over `doc.getArray('kv')` is wrapped with the definition's declared
 * KV record into a synchronous `kv` handle. Its disposal follows the
 * caller-owned document (`doc.once('destroy', ...)`), not the service.
 */
export async function openWorkspaceFromService<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	TKind extends 'standalone' | 'replica',
	TKvMount extends WorkspaceKvMount | undefined = undefined,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	{
		service,
		expectedKind,
		kv,
	}: OpenWorkspaceFromServiceOptions<TKind, TKvMount>,
): Promise<
	OpenedWorkspace<
		TTables,
		TKvMount extends WorkspaceKvMount ? TKv : undefined,
		TKind
	>
> {
	try {
		const description = await service.request({ kind: 'describe' });
		if (
			description.kind !== 'workspace' ||
			description.workspaceKind !== expectedKind ||
			description.workspaceId !== definition.id ||
			description.schemaIdentity !== definition.schemaIdentity
		) {
			throw new Error('Workspace service definition does not match the client');
		}
		// Hydration ordering: never expose the kv handle while local persistence
		// may still be loading; an absent key must not read as the durable
		// default before hydration finished.
		if (kv?.whenHydrated) await kv.whenHydrated;
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

	let kvHandle: Kv<TKv> | undefined;
	if (kv) {
		const store = new YKeyValueLww<unknown>(
			kv.doc.getArray<YKeyValueLwwEntry<unknown>>(KV_KEY),
		);
		kv.doc.once('destroy', () => store[Symbol.dispose]());
		kvHandle = createKv(store, definition.kv);
	}

	let state: 'open' | 'disposing' | 'closed' = 'open';
	let disposePromise: Promise<void> | undefined;
	function disposedError(): Error {
		return new Error('Workspace is disposed');
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
		kind: expectedKind,
		kv: kvHandle,
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
	} as unknown as OpenedWorkspace<
		TTables,
		TKvMount extends WorkspaceKvMount ? TKv : undefined,
		TKind
	>;
}
