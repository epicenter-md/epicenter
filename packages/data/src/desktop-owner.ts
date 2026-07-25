import type { TSchema } from 'typebox';
import { openBunEpicenter } from './bun.js';
import {
	defineLens,
	defineTable,
	defineValue,
	optional,
	type TableDefinition,
	type ValueDefinition,
} from './definitions.js';
import type {
	DesktopOperation,
	DesktopRequest,
	SerializedTableDefinition,
	SerializedValueDefinition,
} from './desktop-protocol.js';
import {
	applyRowDocumentUpdate,
	encodeRowDocumentState,
	type RowDocument,
} from './documents.js';
import {
	type Epicenter,
	type InternalTableLens,
	readTableEntriesPage,
} from './epicenter.js';

type UntypedTableLens = {
	create(fields: Record<string, unknown>): Promise<unknown>;
	get(rowId: string): Promise<unknown>;
	update(rowId: string, patch: Record<string, unknown>): Promise<unknown>;
	delete(rowId: string): Promise<boolean>;
	[readTableEntriesPage](after?: string): Promise<unknown>;
	openDocument(rowId: string): Promise<RowDocument>;
};

type UntypedValueLens = {
	get(): Promise<unknown>;
	set(value: unknown): Promise<void>;
	unset(): Promise<void>;
};

type OpenDocument = {
	surfaceId: string;
	document: RowDocument;
};

export const EPICENTER_STORAGE_MOVED_ERROR_NAME = 'EpicenterStorageMovedError';

/** Open the one Bun-owned desktop Epicenter and its trusted-surface RPC owner. */
export async function createDesktopEpicenterOwner({
	directory,
}: {
	directory: string;
}) {
	const epicenter = await openBunEpicenter({ directory });
	const surfaces = new Map<string, number>();
	const documents = new Map<number, OpenDocument>();
	let operationTail = Promise.resolve();
	let nextGeneration = 0;
	let nextDocumentId = 0;

	async function closeDocument(documentId: number): Promise<void> {
		const opened = documents.get(documentId);
		if (opened === undefined) return;
		documents.delete(documentId);
		await opened.document[Symbol.asyncDispose]();
	}

	async function executeOperation(
		surfaceId: string,
		operation: DesktopOperation,
	): Promise<unknown> {
		if (operation.kind === 'open') {
			const generation = ++nextGeneration;
			surfaces.set(surfaceId, generation);
			return generation;
		}
		if (operation.kind === 'disconnect') {
			for (const [documentId, opened] of documents) {
				if (opened.surfaceId === surfaceId) await closeDocument(documentId);
			}
			surfaces.delete(surfaceId);
			return undefined;
		}
		if (!surfaces.has(surfaceId)) {
			const cause = new Error('Desktop Epicenter moved to a newer surface');
			cause.name = EPICENTER_STORAGE_MOVED_ERROR_NAME;
			throw cause;
		}

		switch (operation.kind) {
			case 'table-create':
				return tableLens(epicenter, operation.definition).create(
					operation.fields,
				);
			case 'table-get':
				return tableLens(epicenter, operation.definition).get(
					operation.address.rowId,
				);
			case 'table-update':
				return tableLens(epicenter, operation.definition).update(
					operation.address.rowId,
					operation.patch,
				);
			case 'table-delete':
				return tableLens(epicenter, operation.definition).delete(
					operation.address.rowId,
				);
			case 'table-entries-page':
				return tableLens(epicenter, operation.definition)[readTableEntriesPage](
					operation.after,
				);
			case 'value-get':
				return valueLens(epicenter, operation.definition).get();
			case 'value-set':
				return valueLens(epicenter, operation.definition).set(operation.value);
			case 'value-unset':
				return valueLens(epicenter, operation.definition).unset();
			case 'document-open': {
				const lens = tableLens(epicenter, operation.definition);
				const document = await lens.openDocument(operation.address.rowId);
				try {
					const documentId = ++nextDocumentId;
					documents.set(documentId, {
						surfaceId,
						document,
					});
					return {
						documentId,
						update: encodeBytes(encodeRowDocumentState(document)),
					};
				} catch (cause) {
					await document[Symbol.asyncDispose]();
					throw cause;
				}
			}
			case 'document-update': {
				const opened = documents.get(operation.documentId);
				if (opened === undefined) throw new Error('Row document is not open');
				applyRowDocumentUpdate(opened.document, decodeBytes(operation.update));
				return undefined;
			}
			case 'document-refresh': {
				const opened = documents.get(operation.documentId);
				if (opened === undefined) throw new Error('Row document is not open');
				return encodeBytes(encodeRowDocumentState(opened.document));
			}
			case 'document-pull': {
				const opened = documents.get(operation.documentId);
				if (opened === undefined) throw new Error('Row document is not open');
				return opened.document.pull();
			}
			case 'document-issue': {
				const opened = documents.get(operation.documentId);
				if (opened === undefined) throw new Error('Row document is not open');
				return opened.document.syncIssue();
			}
			case 'document-close':
				await closeDocument(operation.documentId);
				return undefined;
			default:
				return operation satisfies never;
		}
	}

	return Object.freeze({
		epicenter,
		execute(input: unknown): Promise<unknown> {
			const request = parseDesktopRequest(input);
			// A pull awaits the network; running it on the local queue would
			// stall every SQLite operation behind it. The document runtime owns
			// pull overlap and disposal safety.
			if (request.operation.kind === 'document-pull') {
				return Promise.resolve().then(() =>
					executeOperation(request.surfaceId, request.operation),
				);
			}
			const execution = operationTail.then(() =>
				executeOperation(request.surfaceId, request.operation),
			);
			operationTail = execution.then(
				() => undefined,
				() => undefined,
			);
			return execution;
		},
		async [Symbol.asyncDispose](): Promise<void> {
			await operationTail;
			for (const documentId of [...documents.keys()]) {
				await closeDocument(documentId);
			}
			surfaces.clear();
			await epicenter[Symbol.asyncDispose]();
		},
	});
}

export type DesktopEpicenterOwner = Awaited<
	ReturnType<typeof createDesktopEpicenterOwner>
>;

function tableLens(
	epicenter: Epicenter,
	definition: SerializedTableDefinition,
): UntypedTableLens {
	// The serialized table name is the durable local key, so the reconstructed
	// Lens must declare it under that exact property name. Binding under a fixed
	// placeholder would address every proxied table identically.
	return epicenter.bind(
		defineLens({
			namespace: definition.namespace,
			tables: { [definition.table]: deserializeTable(definition) },
			values: {},
		}),
	).tables[definition.table] as InternalTableLens<TableDefinition>;
}

function valueLens(
	epicenter: Epicenter,
	definition: SerializedValueDefinition,
): UntypedValueLens {
	const valueDefinition = defineValue({
		value: definition.value as TSchema,
	}) as ValueDefinition;
	return epicenter.bind(
		defineLens({
			namespace: definition.address.namespace,
			tables: {},
			values: {
				[definition.address.value]: valueDefinition,
			},
		}),
	).values[definition.address.value] as UntypedValueLens;
}

function deserializeTable(
	definition: SerializedTableDefinition,
): TableDefinition {
	const fields: Record<string, TSchema> = {};
	const optionalFields = new Set(definition.optionalFields);
	for (const [name, schema] of Object.entries(definition.fields)) {
		const typedSchema = schema as TSchema;
		fields[name] = optionalFields.has(name)
			? optional(typedSchema)
			: typedSchema;
	}
	return defineTable({ fields });
}

function parseDesktopRequest(input: unknown): DesktopRequest {
	if (
		typeof input !== 'object' ||
		input === null ||
		Array.isArray(input) ||
		!('surfaceId' in input) ||
		typeof input.surfaceId !== 'string' ||
		input.surfaceId.length === 0 ||
		!('operation' in input) ||
		typeof input.operation !== 'object' ||
		input.operation === null ||
		!('kind' in input.operation) ||
		typeof input.operation.kind !== 'string'
	) {
		throw new TypeError('Invalid desktop Epicenter request');
	}
	return input as DesktopRequest;
}

function encodeBytes(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

function decodeBytes(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, 'base64'));
}
