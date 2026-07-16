import type {
	RecordCommand,
	RecordSyncSqlite,
	SqliteValue,
} from '@epicenter/record-sync';
import type { Static, TSchema } from 'typebox';
import type { CanonicalRecords, CanonicalTable } from './canonical-records.js';
import { createCanonicalRecords } from './canonical-records.js';
import type { DocumentDefinitions } from './document-definition.js';
import {
	createDocumentNamespace,
	type DocumentNamespace,
	type DocumentRoomCatalog,
} from './document-runtime.js';
import type {
	ConstrainedPatch,
	TableLensDefinition,
	TableLensDefinitions,
} from './lens-definition.js';
import type { WorkspaceDefinition } from './runtime-definition.js';

/** One physical canonical record store opened and closed by a runtime. */
export type WorkspaceRecordOwner = {
	sqlite: RecordSyncSqlite;
	/** Persist synchronization intent in the caller's current SQLite transaction. */
	admit?(command: RecordCommand): void;
	[Symbol.asyncDispose](): Promise<void>;
};

export type WorkspaceRecordOwnerFactory = (
	workspaceId: string,
	signal: AbortSignal,
) => Promise<WorkspaceRecordOwner>;

type AsyncCanonicalTable<TDefinition extends TableLensDefinition> = {
	get(id: string): Promise<ReturnType<CanonicalTable<TDefinition>['get']>>;
	scan(
		options: Parameters<CanonicalTable<TDefinition>['scan']>[0],
	): Promise<ReturnType<CanonicalTable<TDefinition>['scan']>>;
	create(
		input: Parameters<CanonicalTable<TDefinition>['create']>[0],
	): Promise<ReturnType<CanonicalTable<TDefinition>['create']>>;
	patch<const TPatch extends Record<string, unknown>>(
		id: string,
		patch: TPatch & ConstrainedPatch<TDefinition, TPatch>,
	): Promise<ReturnType<CanonicalTable<TDefinition>['get']>>;
	delete(id: string): Promise<void>;
};

export type WorkspaceTables<TTables extends TableLensDefinitions> = {
	[K in keyof TTables]: AsyncCanonicalTable<TTables[K]>;
};

export type WorkspaceRecords = {
	/** Run one validated read-only SELECT over connection-local lens views. */
	sql<TResultSchema extends TSchema>(
		query: string,
		parameters: readonly SqliteValue[],
		resultSchema: TResultSchema,
	): Promise<Static<TResultSchema>[]>;
};

type DefinitionTables<TDefinition> =
	TDefinition extends WorkspaceDefinition<infer TTables, DocumentDefinitions>
		? TTables
		: never;

type DefinitionDocuments<TDefinition> =
	TDefinition extends WorkspaceDefinition<
		TableLensDefinitions,
		infer TDocuments
	>
		? TDocuments
		: never;

/** A borrowed typed workspace handle. The runtime owns its lifetime. */
export type OpenedWorkspace<TDefinition extends WorkspaceDefinition> = {
	id: TDefinition['id'];
	tables: WorkspaceTables<DefinitionTables<TDefinition>>;
	documents: DocumentNamespace<DefinitionDocuments<TDefinition>>;
	records: WorkspaceRecords;
};

type RuntimeEntry = {
	definition: WorkspaceDefinition;
	handle?: OpenedWorkspace<WorkspaceDefinition>;
	abortController?: AbortController;
	ownerPromise?: Promise<{
		owner: WorkspaceRecordOwner;
		records: CanonicalRecords;
	}>;
};

/**
 * Create one authority-bound runtime. Opening a definition is inert; the first
 * record operation lazily opens the workspace's single canonical record owner.
 */
export function createWorkspaceRuntime({
	authorityKey,
	documentRoomCatalog,
	openRecordOwner,
}: {
	authorityKey: string;
	documentRoomCatalog: DocumentRoomCatalog;
	openRecordOwner: WorkspaceRecordOwnerFactory;
}) {
	const entries = new Map<string, RuntimeEntry>();
	let isDisposed = false;

	function assertOpen(): void {
		if (isDisposed) throw new Error('Workspace runtime is disposed');
	}

	async function recordsFor(entry: RuntimeEntry): Promise<CanonicalRecords> {
		assertOpen();
		entry.abortController ??= new AbortController();
		entry.ownerPromise ??= (async () => {
			const owner = await openRecordOwner(
				entry.definition.id,
				entry.abortController?.signal ?? AbortSignal.abort(),
			);
			try {
				if (isDisposed) {
					throw new Error(
						'Workspace runtime was disposed while records opened',
					);
				}
				return {
					owner,
					records: createCanonicalRecords(
						owner.sqlite,
						entry.definition.tables,
						{ admit: owner.admit },
					),
				};
			} catch (cause) {
				try {
					await owner[Symbol.asyncDispose]();
				} catch (disposeCause) {
					throw new AggregateError(
						[cause, disposeCause],
						'Workspace record owner initialization and cleanup failed',
					);
				}
				throw cause;
			}
		})().catch((cause) => {
			entry.ownerPromise = undefined;
			throw cause;
		});
		return (await entry.ownerPromise).records;
	}

	function createHandle<TDefinition extends WorkspaceDefinition>(
		definition: TDefinition,
		entry: RuntimeEntry,
	): OpenedWorkspace<TDefinition> {
		const tables = Object.fromEntries(
			Object.keys(definition.tables).map((name) => {
				const table = {
					async get(id: string) {
						return tableFor(await recordsFor(entry), name).get(id);
					},
					async scan(options: { cursor?: string; limit: number }) {
						return tableFor(await recordsFor(entry), name).scan(options);
					},
					async create(input: Record<string, unknown>) {
						return tableFor(await recordsFor(entry), name).create(input);
					},
					async patch(id: string, patch: Record<string, unknown>) {
						return tableFor(await recordsFor(entry), name).patch(id, patch);
					},
					async delete(id: string) {
						tableFor(await recordsFor(entry), name).delete(id);
					},
				};
				return [name, Object.freeze(table)];
			}),
		) as WorkspaceTables<DefinitionTables<TDefinition>>;

		return Object.freeze({
			id: definition.id,
			tables: Object.freeze(tables),
			documents: createDocumentNamespace({
				authorityKey,
				workspaceId: definition.id,
				definitions: definition.documents,
				roomCatalog: documentRoomCatalog,
				assertRuntimeOpen: assertOpen,
			}),
			records: Object.freeze({
				async sql<TResultSchema extends TSchema>(
					query: string,
					parameters: readonly SqliteValue[],
					resultSchema: TResultSchema,
				) {
					return (await recordsFor(entry)).sql(query, parameters, resultSchema);
				},
			}),
		}) as OpenedWorkspace<TDefinition>;
	}

	return {
		/**
		 * Bind one imported definition. Reopening the same definition returns the
		 * same borrowed handle without touching storage.
		 */
		async open<TDefinition extends WorkspaceDefinition>(
			definition: TDefinition,
		): Promise<OpenedWorkspace<TDefinition>> {
			assertOpen();
			const existing = entries.get(definition.id);
			if (existing) {
				if (existing.definition !== definition) {
					throw new Error(
						`Workspace '${definition.id}' is already bound to another definition in this runtime`,
					);
				}
				if (!existing.handle) {
					throw new Error(`Workspace '${definition.id}' has no runtime handle`);
				}
				return existing.handle as OpenedWorkspace<TDefinition>;
			}
			const entry: RuntimeEntry = { definition };
			entry.handle = createHandle(definition, entry);
			entries.set(definition.id, entry);
			return entry.handle as OpenedWorkspace<TDefinition>;
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			for (const entry of entries.values()) entry.abortController?.abort();
			const owners = [...entries.values()].flatMap((entry) =>
				entry.ownerPromise ? [entry.ownerPromise] : [],
			);
			entries.clear();
			const results = await Promise.allSettled(owners);
			const failures: unknown[] = [];
			for (const result of results) {
				if (result.status === 'fulfilled') {
					try {
						await result.value.owner[Symbol.asyncDispose]();
					} catch (cause) {
						failures.push(cause);
					}
				}
			}
			try {
				await documentRoomCatalog[Symbol.asyncDispose]();
			} catch (cause) {
				failures.push(cause);
			}
			if (failures.length > 0) {
				throw new AggregateError(failures, 'Workspace runtime disposal failed');
			}
		},
	};
}

export type WorkspaceRuntime = ReturnType<typeof createWorkspaceRuntime>;

function tableFor(
	records: CanonicalRecords,
	name: string,
): CanonicalTable<TableLensDefinition> {
	const table = records.tables[name];
	if (!table) throw new Error(`Canonical table '${name}' is missing`);
	return table;
}
