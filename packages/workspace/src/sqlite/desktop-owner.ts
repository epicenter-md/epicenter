import {
	parseRowIntent,
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
} from '@epicenter/row-sync';
// The Bun runtime hands out document-provider handles, so the transport
// bridge must come from the same module that owns their Y.Doc registry.
import {
	applyRowDocumentUpdate,
	encodeRowDocumentState,
} from '../document-provider/runtime/index.js';
import { createDeviceBunWorkspaceRuntime } from './bun-runtime.js';
import {
	decodeDocumentBytes,
	encodeDocumentBytes,
} from './canonical-documents.js';

export { DesktopWorkspaceError } from './desktop-protocol.js';

import type { DesktopRecordOperation } from './desktop-protocol.js';
import type { WorkspaceLens } from './workspace-lens.js';

/** Bun-only schema-opaque owner over an explicit Workspace ID allowlist. */
export function createDesktopWorkspaceOwner({
	workspacesRoot,
	workspaceIds,
}: {
	workspacesRoot: string;
	workspaceIds: readonly string[];
}) {
	const allowedWorkspaceIds = new Set<string>();
	for (const workspaceId of workspaceIds) {
		if (allowedWorkspaceIds.has(workspaceId)) {
			throw new Error(`Duplicate desktop workspace '${workspaceId}'`);
		}
		allowedWorkspaceIds.add(workspaceId);
	}
	const runtime = createDeviceBunWorkspaceRuntime({ workspacesRoot });

	const openRegistered = (workspaceId: string) => {
		if (!allowedWorkspaceIds.has(workspaceId)) {
			throw new Error(`Unknown desktop workspace '${workspaceId}'`);
		}
		return runtime.openRaw(workspaceId);
	};

	return Object.freeze({
		/** Local Bun composition only; desktop requests always use raw operations. */
		open<TLens extends WorkspaceLens>(lens: TLens) {
			if (!allowedWorkspaceIds.has(lens.id)) {
				throw new Error(`Unknown desktop workspace '${lens.id}'`);
			}
			return runtime.open(lens);
		},
		hasWorkspace(workspaceId: string): boolean {
			return allowedWorkspaceIds.has(workspaceId);
		},
		async execute(workspaceId: string, input: unknown): Promise<unknown> {
			const operation = parseDesktopRecordOperation(input);
			const workspace = await openRegistered(workspaceId);
			// The awaited acquisition above IS the handshake's work.
			if (operation.kind === 'open') return undefined;
			if (operation.kind === 'sql') {
				return workspace.sql(operation.query, operation.parameters);
			}
			if (operation.kind === 'kv-read-map') {
				return workspace.read(RESERVED_KV_TABLE, RESERVED_KV_ROW_ID) ?? {};
			}
			if (operation.kind === 'admit-intent') {
				workspace.admit(operation.intent);
				return undefined;
			}
			if (operation.kind === 'read-current-row') {
				return workspace.read(operation.table, operation.rowId);
			}
			if (operation.kind === 'list-current-rows') {
				return workspace.list(operation.table);
			}
			if (operation.kind === 'read-current-document') {
				using document = await workspace.document.open(
					operation.table,
					operation.rowId,
				);
				return encodeDocumentBytes(encodeRowDocumentState(document));
			}
			if (operation.kind === 'persist-document-update') {
				await using document = await workspace.document.open(
					operation.table,
					operation.rowId,
				);
				applyRowDocumentUpdate(document, decodeDocumentBytes(operation.update));
				await document.whenDurable();
				return undefined;
			}
			return operation satisfies never;
		},
		async [Symbol.asyncDispose]() {
			await runtime[Symbol.asyncDispose]();
		},
	});
}

export type DesktopWorkspaceOwner = ReturnType<
	typeof createDesktopWorkspaceOwner
>;

function parseDesktopRecordOperation(input: unknown): DesktopRecordOperation {
	if (!isPlainObject(input) || typeof input.kind !== 'string') {
		throw new TypeError('Invalid desktop record operation');
	}
	const table = typeof input.table === 'string' ? input.table : undefined;
	switch (input.kind) {
		case 'open':
			return { kind: 'open' };
		case 'kv-read-map':
			return { kind: 'kv-read-map' };
		case 'admit-intent':
			return { kind: 'admit-intent', intent: parseRowIntent(input.intent) };
		case 'read-current-row':
		case 'read-current-document':
			if (!table || typeof input.rowId !== 'string') break;
			return { kind: input.kind, table, rowId: input.rowId };
		case 'persist-document-update':
			if (
				!table ||
				typeof input.rowId !== 'string' ||
				typeof input.update !== 'string'
			)
				break;
			return {
				kind: 'persist-document-update',
				table,
				rowId: input.rowId,
				update: input.update,
			};
		case 'list-current-rows':
			if (!table) break;
			return { kind: 'list-current-rows', table };
		case 'sql':
			if (
				typeof input.query !== 'string' ||
				!Array.isArray(input.parameters) ||
				!input.parameters.every(
					(value) =>
						value === null ||
						typeof value === 'string' ||
						typeof value === 'number',
				)
			) {
				break;
			}
			return {
				kind: 'sql',
				query: input.query,
				parameters: input.parameters,
			};
	}
	throw new TypeError('Invalid desktop record operation');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
