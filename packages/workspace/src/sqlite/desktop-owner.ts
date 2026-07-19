import { Type } from 'typebox';
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

import {
	type DesktopRecordOperation,
	encodeDesktopRecordResult,
} from './desktop-protocol.js';
import type { WorkspaceHandle } from './runtime.js';
import type { WorkspaceDefinition } from './runtime-definition.js';

const sqliteRows = Type.Record(
	Type.String(),
	Type.Union([Type.String(), Type.Number(), Type.Null()]),
);

type ErasedWorkspace = WorkspaceHandle<WorkspaceDefinition>;
type ErasedKv = {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<unknown>;
	unset(key: string): Promise<void>;
};

/** Bun-only owner over a statically linked set of imported definitions. */
export function createDesktopWorkspaceOwner({
	workspacesRoot,
	definitions,
}: {
	workspacesRoot: string;
	definitions: readonly WorkspaceDefinition[];
}) {
	const catalog = new Map<string, WorkspaceDefinition>();
	for (const definition of definitions) {
		if (catalog.has(definition.id)) {
			throw new Error(`Duplicate desktop workspace '${definition.id}'`);
		}
		catalog.set(definition.id, definition);
	}
	const runtime = createDeviceBunWorkspaceRuntime({ workspacesRoot });
	const handles = new Map<string, Promise<ErasedWorkspace>>();

	const openRegistered = (workspaceId: string): Promise<ErasedWorkspace> => {
		const definition = catalog.get(workspaceId);
		if (!definition) {
			throw new Error(`Unknown desktop workspace '${workspaceId}'`);
		}
		let opening = handles.get(workspaceId);
		if (!opening) {
			opening = runtime.open(definition);
			handles.set(workspaceId, opening);
			void opening.catch(() => {
				if (handles.get(workspaceId) === opening) handles.delete(workspaceId);
			});
		}
		return opening;
	};

	return Object.freeze({
		async open<TDefinition extends WorkspaceDefinition>(
			definition: TDefinition,
		): Promise<WorkspaceHandle<TDefinition>> {
			if (catalog.get(definition.id) !== definition) {
				throw new Error(
					`Desktop workspace '${definition.id}' is not registered with this definition`,
				);
			}
			return (await openRegistered(
				definition.id,
			)) as WorkspaceHandle<TDefinition>;
		},
		hasWorkspace(workspaceId: string): boolean {
			return catalog.has(workspaceId);
		},
		async execute(workspaceId: string, input: unknown): Promise<unknown> {
			const operation = parseDesktopRecordOperation(input);
			const workspace = await openRegistered(workspaceId);
			// The awaited acquisition above IS the handshake's work.
			if (operation.kind === 'open') return undefined;
			if (operation.kind === 'sql') {
				return workspace.sql(operation.query, operation.parameters, sqliteRows);
			}
			if (operation.kind === 'kv-get') {
				return encodeDesktopRecordResult(
					operation,
					await (workspace.kv as unknown as ErasedKv).get(operation.key),
				);
			}
			if (operation.kind === 'kv-set') {
				return (workspace.kv as unknown as ErasedKv).set(
					operation.key,
					operation.value,
				);
			}
			if (operation.kind === 'kv-unset') {
				return (workspace.kv as unknown as ErasedKv).unset(operation.key);
			}
			if (operation.kind === 'read-current-row') {
				const table = workspace.tables[operation.table];
				if (!table) throw new Error(`Unknown table '${operation.table}'`);
				try {
					using _document = await table.document.open(operation.rowId);
					return {};
				} catch (cause) {
					if (cause instanceof Error && /absent row/.test(cause.message)) {
						return undefined;
					}
					throw cause;
				}
			}
			if (operation.kind === 'read-current-document') {
				const table = workspace.tables[operation.table];
				if (!table) throw new Error(`Unknown table '${operation.table}'`);
				using document = await table.document.open(operation.rowId);
				return encodeDocumentBytes(encodeRowDocumentState(document));
			}
			if (operation.kind === 'persist-document-update') {
				const table = workspace.tables[operation.table];
				if (!table) throw new Error(`Unknown table '${operation.table}'`);
				await using document = await table.document.open(operation.rowId);
				applyRowDocumentUpdate(document, decodeDocumentBytes(operation.update));
				await document.whenDurable();
				return undefined;
			}
			const table = workspace.tables[operation.table];
			if (!table) throw new Error(`Unknown table '${operation.table}'`);
			switch (operation.kind) {
				case 'get':
					return encodeDesktopRecordResult(
						operation,
						await table.get(operation.id),
					);
				case 'list':
					return table.list();
				case 'create':
					return table.create(operation.input);
				case 'update': {
					const changes: Record<string, unknown> = { ...operation.set };
					for (const name of operation.unset) changes[name] = undefined;
					return encodeDesktopRecordResult(
						operation,
						await table.update(operation.id, changes),
					);
				}
				case 'delete':
					return table.delete(operation.id);
				default:
					return operation satisfies never;
			}
		},
		async [Symbol.asyncDispose]() {
			handles.clear();
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
	const id = typeof input.id === 'string' ? input.id : undefined;
	switch (input.kind) {
		case 'open':
			return { kind: 'open' };
		case 'kv-get':
		case 'kv-unset':
			if (typeof input.key !== 'string') break;
			return { kind: input.kind, key: input.key };
		case 'kv-set':
			if (typeof input.key !== 'string' || !('value' in input)) break;
			return { kind: 'kv-set', key: input.key, value: input.value };
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
		case 'get':
		case 'delete':
			if (!table || !id) break;
			return { kind: input.kind, table, id };
		case 'list':
			if (!table) break;
			return { kind: 'list', table };
		case 'create':
			if (!table || !isPlainObject(input.input)) break;
			return { kind: 'create', table, input: input.input };
		case 'update':
			if (
				!table ||
				!id ||
				!isPlainObject(input.set) ||
				!Array.isArray(input.unset) ||
				!input.unset.every((name) => typeof name === 'string')
			) {
				break;
			}
			return {
				kind: 'update',
				table,
				id,
				set: input.set,
				unset: input.unset,
			};
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
