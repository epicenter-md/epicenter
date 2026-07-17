import type {
	RecordCommand,
	RecordSyncSqlite,
	SqliteValue,
} from '@epicenter/record-sync';
import type { Static, TSchema } from 'typebox';
import type * as Y from 'yjs';
import type { BodyDefinition, BodyFormat } from './body-definition.js';
import {
	type CanonicalBodies,
	createCanonicalBodies,
} from './canonical-bodies.js';
import { type CanonicalKv, createCanonicalKv } from './canonical-kv.js';
import type { CanonicalRecords, CanonicalTable } from './canonical-records.js';
import { createCanonicalRecords } from './canonical-records.js';
import type {
	KvDefinitions,
	KvReadError,
	KvValues,
	KvWriteError,
} from './kv-definition.js';
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
import type { Result } from 'wellcrafted/result';
import type { WorkspaceDefinition } from './runtime-definition.js';

/** One physical canonical record store opened and closed by a runtime. */
export type WorkspaceRecordOwner = {
	sqlite: RecordSyncSqlite;
	/** Persist synchronization intent in the caller's current SQLite transaction. */
	admit?(command: RecordCommand): void;
	/** Notify after remote state installs, so lenses can re-evaluate. */
	subscribeRemoteCommit?(listener: () => void): () => void;
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

/** One opened row body; format is fixed by the table declaration. */
export type OpenedWorkspaceBody<TFormat extends BodyFormat = BodyFormat> = {
	content: TFormat extends 'richText' ? Y.XmlFragment : Y.Text;
	/** Resolves once every edit issued so far is durably committed. */
	whenDurable(): Promise<void>;
	/** Apply accepted remote updates that arrived since the body opened. */
	refresh(): void;
	[Symbol.dispose](): void;
};

type TableBodySurface<TDefinition extends TableLensDefinition> =
	TDefinition extends { body: BodyDefinition<infer TFormat> }
		? { body: { open(id: string): Promise<OpenedWorkspaceBody<TFormat>> } }
		: { body?: never };

export type WorkspaceTables<TTables extends TableLensDefinitions> = {
	[K in keyof TTables]: AsyncCanonicalTable<TTables[K]> &
		TableBodySurface<TTables[K]>;
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
	TDefinition extends WorkspaceDefinition<
		infer TTables,
		DocumentDefinitions,
		KvDefinitions
	>
		? TTables
		: never;

type DefinitionDocuments<TDefinition> =
	TDefinition extends WorkspaceDefinition<
		TableLensDefinitions,
		infer TDocuments,
		KvDefinitions
	>
		? TDocuments
		: never;

type DefinitionKv<TDefinition> =
	TDefinition extends WorkspaceDefinition<
		TableLensDefinitions,
		DocumentDefinitions,
		infer TKv
	>
		? TKv
		: never;

/** The async typed lens over the canonical KV map (ADR-0130/0132). */
export type WorkspaceKv<TKv extends KvDefinitions> = {
	get<K extends keyof TKv & string>(
		key: K,
	): Promise<Result<KvValues<TKv>[K] | undefined, KvReadError>>;
	set<K extends keyof TKv & string>(
		key: K,
		value: KvValues<TKv>[K],
	): Promise<Result<void, KvWriteError>>;
	unset<K extends keyof TKv & string>(key: K): Promise<void>;
	/**
	 * Observe one declared key. Subscription is established asynchronously
	 * once the record owner opens; the returned disposer always detaches.
	 */
	observe<K extends keyof TKv & string>(
		key: K,
		handler: () => void,
	): () => void;
};

/** A borrowed typed workspace handle. The runtime owns its lifetime. */
export type OpenedWorkspace<TDefinition extends WorkspaceDefinition> = {
	id: TDefinition['id'];
	tables: WorkspaceTables<DefinitionTables<TDefinition>>;
	documents: DocumentNamespace<DefinitionDocuments<TDefinition>>;
	kv: WorkspaceKv<DefinitionKv<TDefinition>>;
	records: WorkspaceRecords;
};

type RuntimeEntry = {
	definition: WorkspaceDefinition;
	handle?: OpenedWorkspace<WorkspaceDefinition>;
	abortController?: AbortController;
	ownerPromise?: Promise<{
		owner: WorkspaceRecordOwner;
		records: CanonicalRecords;
		kv: CanonicalKv<KvDefinitions>;
		bodies: CanonicalBodies;
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

	async function openedFor(entry: RuntimeEntry) {
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
				const records = createCanonicalRecords(
					owner.sqlite,
					entry.definition.tables,
					{ admit: owner.admit },
				);
				const kv = createCanonicalKv(owner.sqlite, entry.definition.kv, {
					admit: owner.admit,
				});
				const bodies = createCanonicalBodies(owner.sqlite, {
					admit: owner.admit,
				});
				owner.subscribeRemoteCommit?.(() => {
					kv.notifyExternalChange();
					bodies.refreshAll();
				});
				return { owner, records, kv, bodies };
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
		return await entry.ownerPromise;
	}

	async function recordsFor(entry: RuntimeEntry): Promise<CanonicalRecords> {
		return (await openedFor(entry)).records;
	}

	function createHandle<TDefinition extends WorkspaceDefinition>(
		definition: TDefinition,
		entry: RuntimeEntry,
	): OpenedWorkspace<TDefinition> {
		const tables = Object.fromEntries(
			Object.entries(definition.tables).map(([name, tableDefinition]) => {
				const bodyDefinition = tableDefinition.body;
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
						const opened = await openedFor(entry);
						tableFor(opened.records, name).delete(id);
						// Deletion is permanent: the local body log dies with it.
						opened.bodies.purgeRow(name, id);
					},
					...(bodyDefinition
						? {
								body: Object.freeze({
									async open(id: string): Promise<OpenedWorkspaceBody> {
										const opened = await openedFor(entry);
										const handle = opened.bodies.open(name, id);
										return {
											content:
												bodyDefinition.format === 'richText'
													? handle.doc.getXmlFragment('body')
													: handle.doc.getText('body'),
											whenDurable: handle.whenDurable,
											refresh: handle.refresh,
											[Symbol.dispose]() {
												handle[Symbol.dispose]();
											},
										};
									},
								}),
							}
						: {}),
				};
				return [name, Object.freeze(table)];
			}),
		) as WorkspaceTables<DefinitionTables<TDefinition>>;

		const kv = Object.freeze({
			async get(key: string) {
				return (await openedFor(entry)).kv.get(key);
			},
			async set(key: string, value: never) {
				return (await openedFor(entry)).kv.set(key, value);
			},
			async unset(key: string) {
				(await openedFor(entry)).kv.unset(key);
			},
			observe(key: string, handler: () => void) {
				let disposed = false;
				let detach: (() => void) | undefined;
				void openedFor(entry).then((opened) => {
					if (disposed) return;
					detach = opened.kv.observe(key, handler);
				});
				return () => {
					disposed = true;
					detach?.();
				};
			},
		}) as WorkspaceKv<DefinitionKv<TDefinition>>;

		return Object.freeze({
			id: definition.id,
			tables: Object.freeze(tables),
			kv,
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
