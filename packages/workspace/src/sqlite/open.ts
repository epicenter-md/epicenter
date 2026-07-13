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
import {
	createWorkspaceDocuments,
	type WorkspaceDocumentRuntime,
	type WorkspaceDocumentRuntimeOption,
	type WorkspaceDocuments,
	type WorkspaceDocumentsFor,
} from './document-client.js';

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

/** @internal Exact subsystem composition accepted by the shared opener. */
export type OpenWorkspaceFromServiceOptions<
	TKind extends 'standalone' | 'replica',
	TKvMount extends WorkspaceKvMount | undefined,
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined,
> = {
	/** A process-local or remote service that owns the SQLite connection. */
	service: OwnedWorkspaceServicePort;
	expectedKind: TKind;
} & WorkspaceKvMountOption<TKvMount> &
	WorkspaceDocumentRuntimeOption<TDocumentRuntime>;

/** @internal Typed KV surface contributed when a root-document mount is present. */
export type WorkspaceKvFor<
	TKvMount extends WorkspaceKvMount | undefined,
	TKv extends KvDefinitions,
> = [TKvMount] extends [undefined]
	? undefined
	: undefined extends TKvMount
		? TKv | undefined
		: TKv;

/** @internal Require the KV mount exactly when the generic says it is present. */
export type WorkspaceKvMountOption<
	TKvMount extends WorkspaceKvMount | undefined,
> = TKvMount extends WorkspaceKvMount
	? {
			/** Preference plane composed over the caller's root Y.Doc. */
			kv: TKvMount;
		}
	: {
			/** Omit for a workspace without mounted KV. */
			kv?: undefined;
		};

/**
 * An opened workspace: async record tables behind their service boundary,
 * plus the KV and child-document surfaces the caller explicitly composed.
 * Without a document runtime, declared child documents expose identity only.
 */
export type OpenedWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions | undefined,
	TKind extends 'standalone' | 'replica',
	TWorkspaceDocuments extends WorkspaceDocuments | undefined = undefined,
> = AsyncWorkspace<TTables, TWorkspaceDocuments> &
	AsyncDisposable & {
		readonly kind: TKind;
		readonly kv: TKv extends KvDefinitions ? Kv<TKv> : undefined;
	};

export type StandaloneWorkspace<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions | undefined = undefined,
	TWorkspaceDocuments extends WorkspaceDocuments | undefined = undefined,
> = OpenedWorkspace<TTables, TKv, 'standalone', TWorkspaceDocuments>;

export type WorkspaceReplica<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions | undefined = undefined,
	TWorkspaceDocuments extends WorkspaceDocuments | undefined = undefined,
> = OpenedWorkspace<TTables, TKv, 'replica', TWorkspaceDocuments>;

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
 *
 * Each document open returns a caller-owned session lease. Disposing its handle
 * releases that lease; the runtime may cache or share the underlying Y.Doc.
 * Workspace disposal blocks new opens but does not dispose handles the caller
 * already opened.
 */
export async function openWorkspaceFromService<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
	const TKind extends 'standalone' | 'replica',
	TKvMount extends WorkspaceKvMount | undefined,
	TDocumentRuntime extends WorkspaceDocumentRuntime | undefined,
>(
	definition: WorkspaceDefinition<TTables, TKv>,
	options: OpenWorkspaceFromServiceOptions<TKind, TKvMount, TDocumentRuntime>,
): Promise<
	OpenedWorkspace<
		TTables,
		WorkspaceKvFor<TKvMount, TKv>,
		TKind,
		WorkspaceDocumentsFor<TDocumentRuntime>
	>
> {
	const { service, expectedKind, kv, documents } = options;
	try {
		const description = await service.request({ kind: 'describe' });
		if (
			description.kind !== 'workspace' ||
			description.workspaceKind !== expectedKind ||
			description.workspaceId !== definition.id ||
			description.schemaIdentity !== definition.recordsSchemaHash
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
	const workspaceDocuments = documents
		? createWorkspaceDocuments(definition.id, documents, () => {
				if (state !== 'open') throw disposedError();
			})
		: undefined;
	const client = workspaceDocuments
		? createWorkspaceClient(definition, gatedService, workspaceDocuments)
		: createWorkspaceClient(definition, gatedService);
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
		WorkspaceKvFor<TKvMount, TKv>,
		TKind,
		WorkspaceDocumentsFor<TDocumentRuntime>
	>;
}
