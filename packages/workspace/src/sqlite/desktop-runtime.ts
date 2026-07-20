import { createDocumentStore } from '../document-provider/persistence.js';
import { createRowDocumentRuntime } from '../document-provider/runtime/index.js';
import {
	isWorkspaceStorageMovedError,
	WORKSPACE_STORAGE_MOVED_ERROR_NAME,
} from './browser-runtime-protocol.js';
import {
	type DesktopRecordOperation,
	type DesktopRecordRequest,
	type DesktopWorkspaceResponse,
	decodeDocumentBytes,
	desktopWorkspaceUrl,
	encodeDocumentBytes,
} from './desktop-protocol.js';
import type { Workspace } from './runtime.js';
import type { WorkspaceLens } from './workspace-lens.js';
import { createWorkspaceView } from './workspace-view.js';

type SurfaceOpenedMessage = {
	type: 'workspace-surface-opened';
	workspaceId: string;
	surfaceId: string;
	generation: number;
};

type DesktopRuntimeBroadcastChannel = {
	onmessage: ((event: MessageEvent<unknown>) => void) | null;
	postMessage(message: unknown): void;
	close(): void;
};

type BoundWorkspace = {
	views: Map<WorkspaceLens, Workspace<WorkspaceLens>>;
	/** The one host open handshake shared by every lens over this ID. */
	opened: Promise<void>;
	documents: ReturnType<typeof createRowDocumentRuntime>;
	/** Set once this surface was displaced; every later operation throws it. */
	moved: Error | undefined;
	/** Host-issued claim generation; larger generations are newer surfaces. */
	generation: number | undefined;
	invalidated: Promise<never>;
	markMoved(cause: Error, notify?: boolean): void;
	disposeDocuments(): Promise<void>;
};

export type CreateDesktopWorkspaceRuntimeOptions = {
	baseUrl?: string;
	fetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	createBroadcastChannel?(
		name: string,
	): DesktopRuntimeBroadcastChannel | undefined;
	onRecordsChanged?(workspaceId: string): void;
	/**
	 * Fired once per workspace when this surface is displaced by a newer one
	 * (newest surface wins). The cause satisfies `isWorkspaceStorageMovedError`,
	 * so apps flip the same blocking moved screen the browser runtime uses.
	 */
	onBackgroundError?(cause: Error, workspaceId: string): void;
};

/**
 * Same-origin WebView client for one Bun-owned static workspace catalog.
 *
 * One runtime instance is one surface. Exactly one surface owns a workspace
 * at a time: opening it here displaces any older surface, and being displaced
 * rejects this runtime's pending and future operations for that workspace
 * with the named moved error. There is no cross-window data relay.
 */
export function createDesktopWorkspaceRuntime({
	baseUrl = location.origin,
	fetch: fetchInput = globalThis.fetch,
	createBroadcastChannel = defaultBroadcastChannel,
	onRecordsChanged = () => undefined,
	onBackgroundError = () => undefined,
}: CreateDesktopWorkspaceRuntimeOptions = {}) {
	const origin = new URL(baseUrl).origin;
	const surfaceId = crypto.randomUUID();
	const workspaces = new Map<string, BoundWorkspace>();
	// The channel carries exactly one lifecycle signal: a newer surface opened
	// a workspace, so a displaced sibling window can flip its moved screen
	// immediately instead of on its next rejected request.
	const surfaceChannel = createBroadcastChannel(
		'epicenter-desktop-workspace-surfaces',
	);
	let disposed = false;

	if (surfaceChannel) {
		surfaceChannel.onmessage = (event: MessageEvent<unknown>) => {
			const message = parseSurfaceOpenedMessage(event.data);
			if (!message || message.surfaceId === surfaceId) return;
			const bound = workspaces.get(message.workspaceId);
			if (
				!bound ||
				bound.moved ||
				message.generation <= (bound.generation ?? 0)
			) {
				return;
			}
			const moved = new Error(
				`Workspace '${message.workspaceId}' moved to a newer window`,
			);
			moved.name = WORKSPACE_STORAGE_MOVED_ERROR_NAME;
			bound.markMoved(moved);
		};
	}

	const request = async <TResult>(
		workspaceId: string,
		operation: DesktopRecordOperation,
	): Promise<TResult> => {
		assertOpen();
		const bound = workspaces.get(workspaceId);
		if (!bound) throw new Error(`Workspace '${workspaceId}' is not open`);
		if (bound.moved) throw bound.moved;
		const response = (async () => {
			const fetched = await fetchInput(
				desktopWorkspaceUrl(origin, workspaceId),
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify({
						surfaceId,
						operation,
					} satisfies DesktopRecordRequest),
				},
			);
			const envelope = (await fetched.json()) as DesktopWorkspaceResponse;
			if (!fetched.ok || envelope.error !== null) {
				const failure = new Error(
					envelope.error?.message ?? `Desktop workspace HTTP ${fetched.status}`,
				);
				if (envelope.error?.name) failure.name = envelope.error.name;
				if (isWorkspaceStorageMovedError(failure)) {
					workspaces.get(workspaceId)?.markMoved(failure);
				}
				throw failure;
			}
			assertOpen();
			if (workspaces.get(workspaceId) !== bound || bound.moved) {
				throw bound.moved ?? new Error(`Workspace '${workspaceId}' is closed`);
			}
			if (operation.kind === 'admit-intent') {
				onRecordsChanged(workspaceId);
			}
			return envelope.data as TResult;
		})();
		return Promise.race([response, bound.invalidated]);
	};

	function assertOpen(): void {
		if (disposed) throw new Error('Desktop workspace runtime is disposed');
	}

	function createBinding(
		workspaceId: string,
	): Omit<BoundWorkspace, 'views' | 'opened'> {
		const invalidated = Promise.withResolvers<never>();
		// A surface can remain current for its entire lifetime, so suppress the
		// process-level unhandled-rejection warning until a request races this
		// lifecycle promise.
		void invalidated.promise.catch(() => undefined);
		const documents = createRowDocumentRuntime({
			// The host owns the durable update log inside the workspace's
			// store.sqlite3; this surface carries only load and append over the
			// same-origin records route.
			store: createDocumentStore({
				async load(address) {
					const parts = await request<string[]>(workspaceId, {
						kind: 'document-load',
						table: address.table,
						rowId: address.rowId,
					});
					return parts.map(decodeDocumentBytes);
				},
				async append(address, update) {
					await request<void>(workspaceId, {
						kind: 'document-append',
						table: address.table,
						rowId: address.rowId,
						update: encodeDocumentBytes(update),
					});
				},
			}),
			isLive: async ({ table, rowId }) =>
				(await request<Record<string, unknown> | undefined>(workspaceId, {
					kind: 'read-current-row',
					table,
					rowId,
				})) !== undefined,
		});
		return {
			documents,
			moved: undefined,
			generation: undefined,
			invalidated: invalidated.promise,
			markMoved(cause: Error, notify = true) {
				const bound = workspaces.get(workspaceId);
				if (!bound || bound.moved) return;
				bound.moved = cause;
				invalidated.reject(cause);
				void documents.revokeAll(cause);
				if (notify) onBackgroundError(cause, workspaceId);
			},
			disposeDocuments: documents[Symbol.asyncDispose],
		};
	}

	function createView<TDefinition extends WorkspaceLens>(
		definition: TDefinition,
		documents: ReturnType<typeof createRowDocumentRuntime>,
	): Workspace<TDefinition> {
		return createWorkspaceView(definition, {
			read(table, rowId) {
				return request(definition.id, {
					kind: 'read-current-row',
					table,
					rowId,
				});
			},
			list(table) {
				return request(definition.id, { kind: 'list-current-rows', table });
			},
			readKvMap() {
				return request(definition.id, { kind: 'kv-read-map' });
			},
			admit(intent) {
				return request(definition.id, { kind: 'admit-intent', intent });
			},
			sql(query, parameters) {
				return request(definition.id, { kind: 'sql', query, parameters });
			},
			openDocument(table, rowId) {
				return documents.open({ table, rowId });
			},
			sync: null,
			afterDelete({ table, rowId }) {
				void documents.revoke({ table, rowId });
			},
		});
	}

	return Object.freeze({
		/**
		 * Opens the workspace and resolves only after the host confirms its
		 * SQLite owner is acquired and this surface owns the workspace. A failed
		 * handshake rejects and unbinds, so a later `open` performs a fresh
		 * handshake against the host.
		 */
		open<TDefinition extends WorkspaceLens>(
			definition: TDefinition,
		): Promise<Workspace<TDefinition>> {
			assertOpen();
			const existing = workspaces.get(definition.id);
			if (existing) {
				const cached = existing.views.get(definition);
				if (cached) return Promise.resolve(cached as Workspace<TDefinition>);
				return existing.opened.then(() => {
					const raced = existing.views.get(definition);
					if (raced) return raced as Workspace<TDefinition>;
					const view = createView(definition, existing.documents);
					existing.views.set(definition, view as Workspace<WorkspaceLens>);
					return view;
				});
			}
			const binding = createBinding(definition.id);
			const bound: BoundWorkspace = {
				...binding,
				views: new Map(),
				opened: undefined as never,
			};
			workspaces.set(definition.id, bound);
			bound.opened = request<number>(definition.id, { kind: 'open' }).then(
				(generation) => {
					bound.generation = generation;
					surfaceChannel?.postMessage({
						type: 'workspace-surface-opened',
						workspaceId: definition.id,
						surfaceId,
						generation,
					} satisfies SurfaceOpenedMessage);
				},
				(cause) => {
					if (workspaces.get(definition.id) === bound) {
						workspaces.delete(definition.id);
					}
					throw cause;
				},
			);
			return bound.opened.then(() => {
				const view = createView(definition, bound.documents);
				bound.views.set(definition, view as Workspace<WorkspaceLens>);
				return view;
			});
		},
		async [Symbol.asyncDispose]() {
			if (disposed) return;
			disposed = true;
			const cause = new Error('Desktop workspace runtime is disposed');
			for (const bound of workspaces.values()) {
				bound.markMoved(cause, false);
			}
			surfaceChannel?.close();
			const failures: unknown[] = [];
			for (const bound of workspaces.values()) {
				try {
					await bound.disposeDocuments();
				} catch (failure) {
					failures.push(failure);
				}
			}
			workspaces.clear();
			if (failures.length > 0) {
				throw new AggregateError(
					failures,
					'Desktop row-document disposal failed',
				);
			}
		},
	});
}

export type DesktopWorkspaceRuntime = ReturnType<
	typeof createDesktopWorkspaceRuntime
>;

function parseSurfaceOpenedMessage(
	value: unknown,
): SurfaceOpenedMessage | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const message = value as Record<string, unknown>;
	if (
		message.type !== 'workspace-surface-opened' ||
		typeof message.workspaceId !== 'string' ||
		typeof message.surfaceId !== 'string' ||
		typeof message.generation !== 'number' ||
		!Number.isSafeInteger(message.generation) ||
		message.generation < 1
	) {
		return undefined;
	}
	return {
		type: 'workspace-surface-opened',
		workspaceId: message.workspaceId,
		surfaceId: message.surfaceId,
		generation: message.generation,
	};
}

function defaultBroadcastChannel(
	name: string,
): DesktopRuntimeBroadcastChannel | undefined {
	return typeof BroadcastChannel === 'undefined'
		? undefined
		: new BroadcastChannel(name);
}
