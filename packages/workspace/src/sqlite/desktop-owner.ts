import {
	parseRowIntent,
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
} from '@epicenter/row-sync';
import { WORKSPACE_STORAGE_MOVED_ERROR_NAME } from './browser-runtime-protocol.js';
import { createDeviceBunWorkspaceRuntime } from './bun-runtime.js';

export { DesktopWorkspaceError } from './desktop-protocol.js';

import {
	type DesktopRecordOperation,
	type DesktopRecordRequest,
	decodeDocumentBytes,
	encodeDocumentBytes,
} from './desktop-protocol.js';
import { assertWorkspaceId, type WorkspaceLens } from './workspace-lens.js';

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
		assertWorkspaceId(workspaceId);
		if (allowedWorkspaceIds.has(workspaceId)) {
			throw new Error(`Duplicate desktop workspace '${workspaceId}'`);
		}
		allowedWorkspaceIds.add(workspaceId);
	}
	const runtime = createDeviceBunWorkspaceRuntime({ workspacesRoot });
	/**
	 * The one live renderer surface per workspace. An `open` from a newer
	 * surface displaces the previous owner; the displaced surface's later
	 * requests fail with the named moved error. In-process host consumers of
	 * owner-opened handles are not surfaces and are unaffected.
	 */
	const surfaces = new Map<string, { surfaceId: string; generation: number }>();
	// Serialize each workspace's surface claim and operations. Once a newer
	// surface's `open` claims the tail, every older operation has either
	// completed before that claim or observes the new owner and rejects. This
	// closes the check-then-await race for document and scalar mutations.
	const operationTails = new Map<string, Promise<void>>();

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
			const previous = operationTails.get(workspaceId) ?? Promise.resolve();
			const execution = previous.then(async () => {
				const { surfaceId, operation } = parseDesktopRecordRequest(input);
				const workspace = await openRegistered(workspaceId);
				if (operation.kind === 'open') {
					// Newest surface wins: opening claims the workspace and displaces
					// any previous surface. The awaited acquisition above IS the
					// handshake's work.
					const generation = (surfaces.get(workspaceId)?.generation ?? 0) + 1;
					surfaces.set(workspaceId, { surfaceId, generation });
					return generation;
				}
				if (surfaces.get(workspaceId)?.surfaceId !== surfaceId) {
					const moved = new Error(
						`Workspace '${workspaceId}' moved to a newer window`,
					);
					moved.name = WORKSPACE_STORAGE_MOVED_ERROR_NAME;
					throw moved;
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
				if (operation.kind === 'document-load') {
					const parts = await runtime.loadDocument(workspaceId, {
						table: operation.table,
						rowId: operation.rowId,
					});
					return parts.map(encodeDocumentBytes);
				}
				if (operation.kind === 'document-append') {
					await runtime.appendDocument(
						workspaceId,
						{ table: operation.table, rowId: operation.rowId },
						decodeDocumentBytes(operation.update),
					);
					return undefined;
				}
				return operation satisfies never;
			});
			operationTails.set(
				workspaceId,
				execution.then(
					() => undefined,
					() => undefined,
				),
			);
			return execution;
		},
		async [Symbol.asyncDispose]() {
			await Promise.allSettled(operationTails.values());
			operationTails.clear();
			surfaces.clear();
			await runtime[Symbol.asyncDispose]();
		},
	});
}

export type DesktopWorkspaceOwner = ReturnType<
	typeof createDesktopWorkspaceOwner
>;

function parseDesktopRecordRequest(input: unknown): DesktopRecordRequest {
	if (
		!isPlainObject(input) ||
		typeof input.surfaceId !== 'string' ||
		input.surfaceId.length === 0
	) {
		throw new TypeError('Invalid desktop record request');
	}
	return {
		surfaceId: input.surfaceId,
		operation: parseDesktopRecordOperation(input.operation),
	};
}

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
		case 'document-load':
			if (!table || typeof input.rowId !== 'string') break;
			return { kind: input.kind, table, rowId: input.rowId };
		case 'document-append':
			if (
				!table ||
				typeof input.rowId !== 'string' ||
				typeof input.update !== 'string'
			)
				break;
			return {
				kind: 'document-append',
				table,
				rowId: input.rowId,
				update: input.update,
			};
		case 'list-current-rows':
			if (!table) break;
			return { kind: 'list-current-rows', table };
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
