import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Type } from 'typebox';
import { createBunWorkspaceRuntime } from './bun-runtime.js';

export { DesktopWorkspaceError } from './desktop-protocol.js';

import type { DesktopRecordOperation } from './desktop-protocol.js';
import type { DocumentDefinition } from './document-definition.js';
import {
	type DocumentRoomManifest,
	resolveDeclaredDocumentRoom,
} from './document-runtime.js';
import type { OpenedWorkspace } from './runtime.js';
import type { WorkspaceDefinition } from './runtime-definition.js';

const sqliteRows = Type.Record(
	Type.String(),
	Type.Union([Type.String(), Type.Number(), Type.Null()]),
);

type ErasedWorkspace = OpenedWorkspace<WorkspaceDefinition>;

/** Bun-only owner over a statically linked set of imported definitions. */
export function createDesktopWorkspaceOwner({
	authorityKey,
	storageRoot,
	definitions,
}: {
	authorityKey: string;
	storageRoot: string;
	definitions: readonly WorkspaceDefinition[];
}) {
	const catalog = new Map<string, WorkspaceDefinition>();
	for (const definition of definitions) {
		if (catalog.has(definition.id)) {
			throw new Error(`Duplicate desktop workspace '${definition.id}'`);
		}
		catalog.set(definition.id, definition);
	}
	const runtime = createBunWorkspaceRuntime({ authorityKey, storageRoot });
	const handles = new Map<string, Promise<ErasedWorkspace>>();
	const roomCatalogRoot = join(resolve(storageRoot), 'documents', 'catalog');
	const authorizedRooms = loadRoomCatalog(roomCatalogRoot);

	const open = (workspaceId: string): Promise<ErasedWorkspace> => {
		const definition = catalog.get(workspaceId);
		if (!definition)
			throw new Error(`Unknown desktop workspace '${workspaceId}'`);
		let opening = handles.get(workspaceId);
		if (!opening) {
			opening = runtime.open(definition);
			handles.set(workspaceId, opening);
		}
		return opening;
	};

	return Object.freeze({
		hasWorkspace(workspaceId: string): boolean {
			return catalog.has(workspaceId);
		},
		async execute(workspaceId: string, input: unknown): Promise<unknown> {
			const operation = parseDesktopRecordOperation(input);
			const workspace = await open(workspaceId);
			if (operation.kind === 'sql') {
				return workspace.records.sql(
					operation.query,
					operation.parameters,
					sqliteRows,
				);
			}
			const table = workspace.tables[operation.table];
			if (!table) throw new Error(`Unknown table '${operation.table}'`);
			switch (operation.kind) {
				case 'get':
					return table.get(operation.id);
				case 'scan':
					return table.scan(operation.options);
				case 'create':
					return table.create(operation.input);
				case 'patch': {
					const patch: Record<string, unknown> = { ...operation.set };
					for (const name of operation.unset) patch[name] = undefined;
					return table.patch(operation.id, patch);
				}
				case 'delete':
					return table.delete(operation.id);
				default:
					return operation satisfies never;
			}
		},
		authorizeDocument(
			workspaceId: string,
			declaration: string,
			params: Record<string, unknown>,
		): DocumentRoomManifest {
			const definition = catalog.get(workspaceId);
			if (!definition) {
				throw new Error(`Unknown desktop workspace '${workspaceId}'`);
			}
			const document = (
				definition.documents as Readonly<Record<string, DocumentDefinition>>
			)[declaration];
			if (!document) {
				throw new Error(`Unknown document declaration '${declaration}'`);
			}
			const manifest = resolveDeclaredDocumentRoom({
				authorityKey,
				workspaceId,
				declaration,
				definition: document,
				params,
			});
			rememberRoomManifest(roomCatalogRoot, authorizedRooms, manifest);
			return manifest;
		},
		isDocumentAuthorized(storageRef: string): boolean {
			return authorizedRooms.has(storageRef);
		},
		async [Symbol.asyncDispose]() {
			handles.clear();
			authorizedRooms.clear();
			await runtime[Symbol.asyncDispose]();
		},
	});
}

function loadRoomCatalog(root: string): Map<string, string> {
	const catalog = new Map<string, string>();
	if (!existsSync(root)) return catalog;
	for (const name of readdirSync(root)) {
		if (!name.endsWith('.json')) continue;
		const path = join(root, name);
		const encoded = readFileSync(path, 'utf8');
		const parsed: unknown = JSON.parse(encoded);
		if (!isDocumentRoomManifest(parsed)) {
			throw new Error(`Invalid desktop document manifest '${path}'`);
		}
		if (`${parsed.storageRef}.json` !== name) {
			throw new Error(`Desktop document manifest filename mismatch '${path}'`);
		}
		const existing = catalog.get(parsed.storageRef);
		if (existing !== undefined && existing !== encoded) {
			throw new Error(
				`Conflicting desktop document manifest '${parsed.storageRef}'`,
			);
		}
		catalog.set(parsed.storageRef, encoded);
	}
	return catalog;
}

function rememberRoomManifest(
	root: string,
	catalog: Map<string, string>,
	manifest: DocumentRoomManifest,
): void {
	const encoded = JSON.stringify(manifest);
	const existing = catalog.get(manifest.storageRef);
	if (existing !== undefined) {
		if (existing !== encoded) {
			throw new Error(
				`Document room manifest conflicts with persisted catalog: ${manifest.storageRef}`,
			);
		}
		return;
	}
	const path = join(root, `${manifest.storageRef}.json`);
	writeFileAtomic(path, encoded);
	catalog.set(manifest.storageRef, encoded);
}

function isDocumentRoomManifest(value: unknown): value is DocumentRoomManifest {
	return (
		isPlainObject(value) &&
		value.formatVersion === 1 &&
		typeof value.storageRef === 'string' &&
		typeof value.workspaceId === 'string' &&
		typeof value.declaration === 'string' &&
		typeof value.documentFormat === 'string' &&
		isPlainObject(value.params)
	);
}

function writeFileAtomic(path: string, value: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, value, { flag: 'wx' });
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
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
		case 'get':
		case 'delete':
			if (!table || !id) break;
			return { kind: input.kind, table, id };
		case 'scan':
			if (!table || !isPlainObject(input.options)) break;
			if (
				typeof input.options.limit !== 'number' ||
				(input.options.cursor !== undefined &&
					typeof input.options.cursor !== 'string')
			)
				break;
			return {
				kind: 'scan',
				table,
				options: {
					limit: input.options.limit,
					...(input.options.cursor !== undefined && {
						cursor: input.options.cursor,
					}),
				},
			};
		case 'create':
			if (!table || !isPlainObject(input.input)) break;
			return { kind: 'create', table, input: input.input };
		case 'patch':
			if (
				!table ||
				!id ||
				!isPlainObject(input.set) ||
				!Array.isArray(input.unset) ||
				!input.unset.every((name) => typeof name === 'string')
			)
				break;
			return {
				kind: 'patch',
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
			)
				break;
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
