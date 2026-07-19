import { createAsyncWorkspaceView } from './async-workspace-view.js';
import {
	createDocumentRuntime,
	decodeDocumentBytes,
	encodeDocumentBytes,
} from './canonical-documents.js';
import {
	type DesktopRecordOperation,
	type DesktopWorkspaceResponse,
	desktopWorkspaceUrl,
} from './desktop-protocol.js';
import type { Workspace } from './runtime.js';
import type { WorkspaceLens } from './workspace-lens.js';

type RowAddress = { table: string; rowId: string };

type DesktopInvalidationMessage =
	| { type: 'records-changed'; workspaceId: string }
	| { type: 'rows-deleted'; workspaceId: string; addresses: RowAddress[] }
	| {
			type: 'document-updated';
			workspaceId: string;
			address: RowAddress;
			/** Base64 document-provider transport encoding of one Yjs update. */
			update: string;
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
	documents: ReturnType<typeof createDocumentRuntime>;
	revokeRows(addresses: RowAddress[]): void;
	revokeDocuments(cause: Error): void;
	applyDocumentUpdate(address: RowAddress, update: Uint8Array): void;
};

export type CreateDesktopWorkspaceRuntimeOptions = {
	baseUrl?: string;
	fetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	createBroadcastChannel?(
		name: string,
	): DesktopRuntimeBroadcastChannel | undefined;
	onRecordsChanged?(workspaceId: string): void;
};

/** Same-origin WebView client for one Bun-owned static workspace catalog. */
export function createDesktopWorkspaceRuntime({
	baseUrl = location.origin,
	fetch: fetchInput = globalThis.fetch,
	createBroadcastChannel = defaultBroadcastChannel,
	onRecordsChanged = () => undefined,
}: CreateDesktopWorkspaceRuntimeOptions = {}) {
	const origin = new URL(baseUrl).origin;
	const workspaces = new Map<string, BoundWorkspace>();
	const invalidationChannel = createBroadcastChannel(
		'epicenter-desktop-workspaces',
	);
	let disposed = false;

	function emitRecordsChanged(workspaceId: string, broadcast: boolean): void {
		if (broadcast) {
			invalidationChannel?.postMessage({
				type: 'records-changed',
				workspaceId,
			} satisfies DesktopInvalidationMessage);
		}
		onRecordsChanged(workspaceId);
	}

	if (invalidationChannel) {
		invalidationChannel.onmessage = (event: MessageEvent<unknown>) => {
			const message = parseInvalidationMessage(event.data);
			if (!message || !workspaces.has(message.workspaceId)) return;
			switch (message.type) {
				case 'records-changed':
					emitRecordsChanged(message.workspaceId, false);
					return;
				case 'rows-deleted':
					workspaces.get(message.workspaceId)?.revokeRows(message.addresses);
					return;
				case 'document-updated':
					workspaces
						.get(message.workspaceId)
						?.applyDocumentUpdate(
							message.address,
							decodeDocumentBytes(message.update),
						);
					emitRecordsChanged(message.workspaceId, false);
					return;
			}
		};
	}

	const request = async <TResult>(
		workspaceId: string,
		operation: DesktopRecordOperation,
	): Promise<TResult> => {
		assertOpen();
		const response = await fetchInput(
			desktopWorkspaceUrl(origin, workspaceId),
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify(operation),
			},
		);
		const envelope = (await response.json()) as DesktopWorkspaceResponse;
		if (!response.ok || envelope.error !== null) {
			throw new Error(
				envelope.error?.message ?? `Desktop workspace HTTP ${response.status}`,
			);
		}
		if (
			operation.kind === 'admit-intent' ||
			operation.kind === 'persist-document-update'
		) {
			emitRecordsChanged(workspaceId, true);
		}
		return envelope.data as TResult;
	};

	function assertOpen(): void {
		if (disposed) throw new Error('Desktop workspace runtime is disposed');
	}

	function createBinding(workspaceId: string): {
		documents: ReturnType<typeof createDocumentRuntime>;
		revokeRows(addresses: RowAddress[]): void;
		revokeDocuments(cause: Error): void;
		applyDocumentUpdate(address: RowAddress, update: Uint8Array): void;
	} {
		const documents = createDocumentRuntime({
			async persistUpdate(table, rowId, update) {
				const encoded = encodeDocumentBytes(update);
				await request(workspaceId, {
					kind: 'persist-document-update',
					table,
					rowId,
					update: encoded,
				});
				// Another client with this document open applies the update
				// directly; without this, its cached Y.Doc goes stale until the
				// document is reopened.
				invalidationChannel?.postMessage({
					type: 'document-updated',
					workspaceId,
					address: { table, rowId },
					update: encoded,
				} satisfies DesktopInvalidationMessage);
			},
			readCurrentRow(table, rowId) {
				return request(workspaceId, {
					kind: 'read-current-row',
					table,
					rowId,
				});
			},
			async readParts(table, rowId) {
				const state = await request<string>(workspaceId, {
					kind: 'read-current-document',
					table,
					rowId,
				});
				return [decodeDocumentBytes(state)];
			},
		});
		return {
			documents,
			revokeRows: documents.revoke,
			revokeDocuments: documents.revokeAll,
			applyDocumentUpdate(address, update) {
				documents.applyRelayedUpdate(address, update);
			},
		};
	}

	function createView<TDefinition extends WorkspaceLens>(
		definition: TDefinition,
		documents: ReturnType<typeof createDocumentRuntime>,
	): Workspace<TDefinition> {
		return createAsyncWorkspaceView(definition, {
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
				return documents.open(table, rowId);
			},
			sync: null,
			afterDelete({ table, rowId }) {
				documents.revoke([{ table, rowId }]);
				invalidationChannel?.postMessage({
					type: 'rows-deleted',
					workspaceId: definition.id,
					addresses: [{ table, rowId }],
				} satisfies DesktopInvalidationMessage);
			},
		});
	}

	return Object.freeze({
		/**
		 * Opens the workspace and resolves only after the host confirms its
		 * SQLite owner is acquired. A failed handshake rejects and unbinds, so
		 * a later `open` performs a fresh handshake against the host.
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
			bound.opened = request<void>(definition.id, { kind: 'open' }).then(
				() => undefined,
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
			for (const bound of workspaces.values()) bound.revokeDocuments(cause);
			workspaces.clear();
			invalidationChannel?.close();
		},
	});
}

export type DesktopWorkspaceRuntime = ReturnType<
	typeof createDesktopWorkspaceRuntime
>;

function parseInvalidationMessage(
	value: unknown,
): DesktopInvalidationMessage | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const message = value as Record<string, unknown>;
	if (typeof message.workspaceId !== 'string') return undefined;
	if (message.type === 'records-changed') {
		return {
			type: message.type,
			workspaceId: message.workspaceId,
		};
	}
	if (
		message.type === 'document-updated' &&
		isRowAddress(message.address) &&
		typeof message.update === 'string'
	) {
		return {
			type: 'document-updated',
			workspaceId: message.workspaceId,
			address: message.address,
			update: message.update,
		};
	}
	if (
		message.type !== 'rows-deleted' ||
		!Array.isArray(message.addresses) ||
		!message.addresses.every(isRowAddress)
	) {
		return undefined;
	}
	return {
		type: 'rows-deleted',
		workspaceId: message.workspaceId,
		addresses: message.addresses,
	};
}

function isRowAddress(value: unknown): value is RowAddress {
	return (
		typeof value === 'object' &&
		value !== null &&
		'table' in value &&
		typeof value.table === 'string' &&
		'rowId' in value &&
		typeof value.rowId === 'string'
	);
}

function defaultBroadcastChannel(
	name: string,
): DesktopRuntimeBroadcastChannel | undefined {
	return typeof BroadcastChannel === 'undefined'
		? undefined
		: new BroadcastChannel(name);
}
