/**
 * Durable replica lifecycle over the typed SQLite application database.
 *
 * This module owns replica identity, the transactional outbox, the pull cursor,
 * verified snapshot staging, and the exact protocol checks between those
 * durable facts and a record-sync authority.
 */

import {
	isValidSnapshotChunk,
	isValidSnapshotManifest,
	type Mutation,
	type PullRequest,
	type PushRequest,
	parseMutation,
	parsePullResponse,
	parsePushResponse,
	parseSnapshotChunkResponse,
	type RecordAuthorityBindingRequest,
	type RecordSyncSqlite,
	type RequestEnvelope,
	type Sha256,
	type SnapshotChunk,
	type SnapshotChunkRequest,
	type SnapshotManifest,
} from '@epicenter/record-sync';
import {
	type ApplicationMutationContext,
	type ApplicationMutationCoordinator,
	createApplicationDatabase,
} from './database.js';
import type {
	KvDefinitions,
	TableDefinitions,
	WorkspaceDefinition,
} from './definition.js';

const SYNC_STORAGE_VERSION = 1;
const DEFAULT_PULL_LIMIT = 100;
const META_TABLE = '__epicenter_replica';
const OUTBOX_TABLE = '__epicenter_replica_outbox';
const SNAPSHOT_TABLE = '__epicenter_replica_snapshot';
const SNAPSHOT_CHUNK_TABLE = '__epicenter_replica_snapshot_chunks';

export type ReplicaDatabaseBindingRequest = RecordAuthorityBindingRequest & {
	workspaceId: string;
};

type ReplicaDatabaseBinding = {
	databaseIncarnationId: string;
};

/** Network boundary implemented by the hosted or self-hosted sync client. */
export type ReplicaSyncPort = {
	/** Select the workspace route locally without performing network I/O. */
	bindWorkspace(workspaceId: string): void;
	openDatabase(
		request: ReplicaDatabaseBindingRequest,
		signal?: AbortSignal,
	): Promise<unknown>;
	push(request: PushRequest, signal?: AbortSignal): Promise<unknown>;
	pull(request: PullRequest, signal?: AbortSignal): Promise<unknown>;
	snapshotChunk(
		request: SnapshotChunkRequest,
		signal?: AbortSignal,
	): Promise<unknown>;
};

export type CreateReplicaRuntimeOptions<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = {
	definition: WorkspaceDefinition<TTables, TKv>;
	sqlite: RecordSyncSqlite;
	sync: ReplicaSyncPort;
	protocolMajor: number;
	createActorId(): string;
	sha256: Sha256;
	onObserverError(error: unknown): void;
	pullLimit?: number;
};

type ReplicaMeta = {
	actorId: string;
	nextActorSequence: number;
	appliedServerSequence: number;
	databaseIncarnationId: string;
	protocolMajor: number;
	syncStorageVersion: number;
};

/** Open one durable replica and bind it to the authority's database incarnation. */
export async function createReplicaRuntime<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
>({
	definition,
	sqlite,
	sync,
	protocolMajor,
	createActorId,
	sha256,
	onObserverError,
	pullLimit = DEFAULT_PULL_LIMIT,
}: CreateReplicaRuntimeOptions<TTables, TKv>) {
	assertPositiveInteger(protocolMajor, 'protocolMajor');
	if (!Number.isSafeInteger(pullLimit) || pullLimit < 1 || pullLimit > 1_000) {
		throw new TypeError('pullLimit must be an integer from 1 through 1000');
	}
	const coordinator: ApplicationMutationCoordinator = {
		commit<TResult>(
			context: ApplicationMutationContext,
			apply: () => TResult,
		): TResult {
			return sqlite.transaction(() => {
				const result = apply();
				if (context.operations.length === 0) return result;
				const meta = readMeta(sqlite);
				if (meta.nextActorSequence >= Number.MAX_SAFE_INTEGER) {
					throw new Error('Replica actor sequence is exhausted');
				}
				const mutation = parseMutation({
					actorId: meta.actorId,
					actorSequence: meta.nextActorSequence,
					operations: structuredClone([...context.operations]),
				});
				sqlite.run(
					`INSERT INTO ${OUTBOX_TABLE}(actor_sequence, operations_json) VALUES (?, ?)`,
					[mutation.actorSequence, JSON.stringify(mutation.operations)],
				);
				sqlite.run(
					`UPDATE ${META_TABLE} SET next_actor_sequence = ? WHERE id = 1`,
					[mutation.actorSequence + 1],
				);
				return result;
			});
		},
	};
	const database = createApplicationDatabase(definition, sqlite, {
		kind: 'replica',
		coordinator,
		onObserverError,
	});
	initializeReplicaTables(sqlite);

	const bindingRequest = {
		workspaceId: definition.id,
		schemaIdentity: definition.schemaIdentity,
		protocolMajor,
	};
	sync.bindWorkspace(bindingRequest.workspaceId);
	const existing = readMetaIfPresent(sqlite);
	let isAuthorityBindingVerified = false;
	if (existing) {
		assertStoredReplicaCompatibility(existing, protocolMajor);
	} else {
		const { databaseIncarnationId } = parseDatabaseBinding(
			await sync.openDatabase(bindingRequest),
		);
		assertNonEmpty(databaseIncarnationId, 'databaseIncarnationId');
		createReplicaBinding({
			sqlite,
			protocolMajor,
			databaseIncarnationId,
			createActorId,
		});
		isAuthorityBindingVerified = true;
	}

	async function verifyAuthorityBinding(signal?: AbortSignal): Promise<void> {
		if (isAuthorityBindingVerified) return;
		const { databaseIncarnationId } = parseDatabaseBinding(
			await sync.openDatabase(bindingRequest, signal),
		);
		assertNonEmpty(databaseIncarnationId, 'databaseIncarnationId');
		if (databaseIncarnationId !== readMeta(sqlite).databaseIncarnationId) {
			throw new Error(
				'Replica database incarnation no longer matches authority',
			);
		}
		isAuthorityBindingVerified = true;
	}

	function envelope(meta = readMeta(sqlite)): RequestEnvelope {
		return {
			protocolMajor: meta.protocolMajor,
			schemaIdentity: definition.schemaIdentity,
			databaseIncarnationId: meta.databaseIncarnationId,
		};
	}

	async function push(signal?: AbortSignal): Promise<void> {
		const mutations = readOutbox(sqlite);
		if (mutations.length === 0) return;
		const request: PushRequest = {
			kind: 'push',
			...envelope(),
			mutations,
		};
		const response = parsePushResponse(await sync.push(request, signal));
		if (!response.ok) {
			throw new Error(`Replica push refused: ${response.reason}`);
		}
	}

	async function installSnapshot(
		manifest: SnapshotManifest,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (!(await isValidSnapshotManifest(sha256, manifest))) {
			throw new Error(
				'Replica authority returned an invalid snapshot manifest',
			);
		}
		const cursor = readMeta(sqlite).appliedServerSequence;
		if (manifest.snapshotSequence <= cursor) {
			throw new Error('Replica authority returned a stale required snapshot');
		}
		const existingStagedManifest = readStagedManifest(sqlite);
		if (
			!existingStagedManifest ||
			existingStagedManifest.checksum !== manifest.checksum ||
			existingStagedManifest.generation !== manifest.generation
		) {
			sqlite.transaction(() => {
				sqlite.run(`DELETE FROM ${SNAPSHOT_CHUNK_TABLE}`);
				sqlite.run(`DELETE FROM ${SNAPSHOT_TABLE}`);
				sqlite.run(
					`INSERT INTO ${SNAPSHOT_TABLE}(id, manifest_json) VALUES (1, ?)`,
					[JSON.stringify(manifest)],
				);
			});
		}

		for (let index = 0; index < manifest.chunkChecksums.length; index += 1) {
			const stagedChunk = readStagedChunk(sqlite, index);
			if (
				stagedChunk &&
				stagedChunk.generation === manifest.generation &&
				stagedChunk.index === index &&
				stagedChunk.checksum === manifest.chunkChecksums[index] &&
				(await isValidSnapshotChunk(sha256, stagedChunk))
			) {
				continue;
			}
			const request: SnapshotChunkRequest = {
				kind: 'snapshotChunk',
				...envelope(),
				generation: manifest.generation,
				index,
			};
			const response = parseSnapshotChunkResponse(
				await sync.snapshotChunk(request, signal),
			);
			if (!response.ok) {
				throw new Error(`Replica snapshot chunk refused: ${response.reason}`);
			}
			const chunk = response.chunk;
			if (
				chunk.generation !== manifest.generation ||
				chunk.index !== index ||
				chunk.checksum !== manifest.chunkChecksums[index] ||
				!(await isValidSnapshotChunk(sha256, chunk))
			) {
				throw new Error(`Replica snapshot chunk ${index} failed verification`);
			}
			sqlite.run(
				`INSERT OR REPLACE INTO ${SNAPSHOT_CHUNK_TABLE}(chunk_index, chunk_json) VALUES (?, ?)`,
				[index, JSON.stringify(chunk)],
			);
		}

		const stagedManifestJson = sqlite.all<{ manifestJson: string }>(
			`SELECT manifest_json AS manifestJson FROM ${SNAPSHOT_TABLE} WHERE id = 1`,
		)[0]?.manifestJson;
		if (stagedManifestJson === undefined) {
			throw new Error('Staged replica snapshot manifest is missing');
		}
		const stagedManifest = parseStagedManifest(stagedManifestJson);
		if (
			stagedManifest.checksum !== manifest.checksum ||
			!(await isValidSnapshotManifest(sha256, stagedManifest))
		) {
			throw new Error('Staged replica snapshot manifest is corrupt');
		}
		const chunks = sqlite
			.all<{ chunkJson: string }>(
				`SELECT chunk_json AS chunkJson FROM ${SNAPSHOT_CHUNK_TABLE} ORDER BY chunk_index`,
			)
			.map(({ chunkJson }) => parseStagedChunk(chunkJson));
		if (chunks.length !== manifest.chunkChecksums.length) {
			throw new Error('Staged replica snapshot is incomplete');
		}
		for (const [index, chunk] of chunks.entries()) {
			if (
				chunk.generation !== manifest.generation ||
				chunk.index !== index ||
				chunk.checksum !== manifest.chunkChecksums[index] ||
				!(await isValidSnapshotChunk(sha256, chunk))
			) {
				throw new Error(`Staged replica snapshot chunk ${index} is corrupt`);
			}
		}
		const staged = chunks.flatMap(({ rows }) => rows);
		const currentMeta = readMeta(sqlite);
		const currentOutbox = readOutbox(sqlite);
		const acceptedThrough = validateSnapshotActorHighWater(
			currentMeta,
			currentOutbox,
			manifest.actorHighWater[currentMeta.actorId] ?? 0,
		);
		return database.applyReplicaTransaction((projection) => {
			const current = readMeta(sqlite);
			if (manifest.snapshotSequence <= current.appliedServerSequence) {
				return false;
			}
			projection.replace(staged, manifest.snapshotSequence);
			sqlite.run(`DELETE FROM ${OUTBOX_TABLE} WHERE actor_sequence <= ?`, [
				acceptedThrough,
			]);
			sqlite.run(
				`UPDATE ${META_TABLE} SET applied_server_sequence = ? WHERE id = 1`,
				[manifest.snapshotSequence],
			);
			for (const pending of readOutbox(sqlite)) {
				projection.apply(pending.operations, manifest.snapshotSequence + 1);
			}
			sqlite.run(`DELETE FROM ${SNAPSHOT_CHUNK_TABLE}`);
			sqlite.run(`DELETE FROM ${SNAPSHOT_TABLE}`);
			return true;
		});
	}

	async function pull(signal?: AbortSignal): Promise<void> {
		for (;;) {
			const meta = readMeta(sqlite);
			const request: PullRequest = {
				kind: 'pull',
				...envelope(meta),
				cursor: meta.appliedServerSequence,
				limit: pullLimit,
			};
			const response = parsePullResponse(await sync.pull(request, signal));
			if (!response.ok) {
				throw new Error(`Replica pull refused: ${response.reason}`);
			}
			if (response.snapshotRequired) {
				await installSnapshot(response.manifest, signal);
				continue;
			}
			assertPullPage(request, response, readOutbox(sqlite), meta.actorId);
			const applied = database.applyReplicaTransaction((projection) => {
				const current = readMeta(sqlite);
				if (current.appliedServerSequence !== request.cursor) {
					return false;
				}
				for (const mutation of response.mutations) {
					projection.apply(mutation.operations, mutation.serverSequence);
					if (mutation.actorId === current.actorId) {
						sqlite.run(`DELETE FROM ${OUTBOX_TABLE} WHERE actor_sequence = ?`, [
							mutation.actorSequence,
						]);
					}
				}
				sqlite.run(
					`UPDATE ${META_TABLE} SET applied_server_sequence = ? WHERE id = 1`,
					[response.newCursor],
				);
				for (const pending of readOutbox(sqlite)) {
					projection.apply(pending.operations, response.newCursor + 1);
				}
				return true;
			});
			if (!applied) continue;
			if (!response.hasMore) return;
		}
	}

	let syncTail = Promise.resolve();
	return {
		database,
		/** Push pending mutations, then install every currently available page. */
		async syncOnce(signal?: AbortSignal): Promise<void> {
			const run = async () => {
				signal?.throwIfAborted();
				await verifyAuthorityBinding(signal);
				await push(signal);
				await pull(signal);
			};
			const result = syncTail.then(run, run);
			syncTail = result.catch(() => {});
			await result;
		},
		/** Inspect durable protocol state for diagnostics and tests. */
		inspect() {
			return { ...readMeta(sqlite), outbox: readOutbox(sqlite) };
		},
	};
}

export type ReplicaSyncSupervisorOptions = {
	pollIntervalMs?: number;
	retryDelaysMs?: readonly number[];
	onError(error: unknown): void;
};

/** Keep one replica converging without turning transport failures into writes. */
export function startReplicaSyncSupervisor(
	runtime: { syncOnce(signal?: AbortSignal): Promise<void> },
	{
		pollIntervalMs = 30_000,
		retryDelaysMs = [1_000, 2_500, 5_000, 10_000],
		onError,
	}: ReplicaSyncSupervisorOptions,
) {
	if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
		throw new TypeError('pollIntervalMs must be a non-negative safe integer');
	}
	let isDisposed = false;
	let requested = false;
	let failureCount = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running: Promise<void> | undefined;
	let controller: AbortController | undefined;

	function report(error: unknown): void {
		try {
			onError(error);
		} catch {
			// A broken diagnostic sink must not stop later synchronization.
		}
	}

	function schedule(delayMs: number): void {
		if (isDisposed) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			request();
		}, delayMs);
	}

	function run(): Promise<void> {
		if (running) return running;
		running = (async () => {
			while (requested && !isDisposed) {
				requested = false;
				controller = new AbortController();
				try {
					await runtime.syncOnce(controller.signal);
					failureCount = 0;
				} catch (error) {
					if (isDisposed && controller.signal.aborted) return;
					report(error);
					const delay =
						retryDelaysMs[
							Math.min(failureCount, Math.max(0, retryDelaysMs.length - 1))
						] ?? 0;
					failureCount++;
					schedule(delay);
					return;
				} finally {
					controller = undefined;
				}
			}
			if (!isDisposed && pollIntervalMs > 0) schedule(pollIntervalMs);
		})().finally(() => {
			running = undefined;
			if (requested && !isDisposed) void run();
		});
		return running;
	}

	function request(): void {
		if (isDisposed) return;
		requested = true;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		void run();
	}

	return {
		request,
		async dispose(): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			if (timer) clearTimeout(timer);
			controller?.abort();
			await running;
		},
	};
}

export type ReplicaRuntime<
	TTables extends TableDefinitions,
	TKv extends KvDefinitions,
> = Awaited<ReturnType<typeof createReplicaRuntime<TTables, TKv>>>;

function initializeReplicaTables(sqlite: RecordSyncSqlite): void {
	sqlite.transaction(() => {
		sqlite.run(
			`CREATE TABLE IF NOT EXISTS ${META_TABLE}(
				id INTEGER PRIMARY KEY CHECK(id = 1),
				actor_id TEXT NOT NULL,
				next_actor_sequence INTEGER NOT NULL CHECK(next_actor_sequence >= 1),
				applied_server_sequence INTEGER NOT NULL CHECK(applied_server_sequence >= 0),
				database_incarnation_id TEXT NOT NULL,
				protocol_major INTEGER NOT NULL CHECK(protocol_major >= 1),
				sync_storage_version INTEGER NOT NULL CHECK(sync_storage_version >= 1)
			)`,
		);
		sqlite.run(
			`CREATE TABLE IF NOT EXISTS ${OUTBOX_TABLE}(
				actor_sequence INTEGER PRIMARY KEY,
				operations_json TEXT NOT NULL
			)`,
		);
		sqlite.run(
			`CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE}(
				id INTEGER PRIMARY KEY CHECK(id = 1),
				manifest_json TEXT NOT NULL
			)`,
		);
		sqlite.run(
			`CREATE TABLE IF NOT EXISTS ${SNAPSHOT_CHUNK_TABLE}(
				chunk_index INTEGER PRIMARY KEY CHECK(chunk_index >= 0),
				chunk_json TEXT NOT NULL
			)`,
		);
	});
}

function createReplicaBinding({
	sqlite,
	protocolMajor,
	databaseIncarnationId,
	createActorId,
}: {
	sqlite: RecordSyncSqlite;
	protocolMajor: number;
	databaseIncarnationId: string;
	createActorId(): string;
}): void {
	const actorId = createActorId();
	assertNonEmpty(actorId, 'actorId');
	sqlite.run(
		`INSERT INTO ${META_TABLE}(
			id, actor_id, next_actor_sequence, applied_server_sequence,
			database_incarnation_id, protocol_major, sync_storage_version
		) VALUES (1, ?, 1, 0, ?, ?, ?)`,
		[actorId, databaseIncarnationId, protocolMajor, SYNC_STORAGE_VERSION],
	);
}

function assertStoredReplicaCompatibility(
	meta: ReplicaMeta,
	protocolMajor: number,
): void {
	if (meta.syncStorageVersion !== SYNC_STORAGE_VERSION) {
		throw new Error('Replica sync storage version is unsupported');
	}
	if (meta.protocolMajor !== protocolMajor) {
		throw new Error('Replica protocol major does not match this runtime');
	}
}

type ReplicaMetaRow = {
	actor_id: string;
	next_actor_sequence: number;
	applied_server_sequence: number;
	database_incarnation_id: string;
	protocol_major: number;
	sync_storage_version: number;
};

function readMeta(sqlite: RecordSyncSqlite): ReplicaMeta {
	const meta = readMetaIfPresent(sqlite);
	if (!meta) throw new Error('Replica metadata is missing');
	return meta;
}

function readMetaIfPresent(sqlite: RecordSyncSqlite): ReplicaMeta | undefined {
	const row = sqlite.all<ReplicaMetaRow>(`SELECT * FROM ${META_TABLE}`)[0];
	return row ? decodeMeta(row) : undefined;
}

function decodeMeta(row: ReplicaMetaRow): ReplicaMeta {
	assertNonEmpty(row.actor_id, 'stored actorId');
	assertPositiveInteger(row.next_actor_sequence, 'stored nextActorSequence');
	if (
		!Number.isSafeInteger(row.applied_server_sequence) ||
		row.applied_server_sequence < 0
	) {
		throw new Error('Stored appliedServerSequence is invalid');
	}
	assertNonEmpty(row.database_incarnation_id, 'stored databaseIncarnationId');
	assertPositiveInteger(row.protocol_major, 'stored protocolMajor');
	assertPositiveInteger(row.sync_storage_version, 'stored syncStorageVersion');
	return {
		actorId: row.actor_id,
		nextActorSequence: row.next_actor_sequence,
		appliedServerSequence: row.applied_server_sequence,
		databaseIncarnationId: row.database_incarnation_id,
		protocolMajor: row.protocol_major,
		syncStorageVersion: row.sync_storage_version,
	};
}

function readOutbox(sqlite: RecordSyncSqlite): Mutation[] {
	const actorId = readMeta(sqlite).actorId;
	return sqlite
		.all<{ actorSequence: number; operationsJson: string }>(
			`SELECT actor_sequence AS actorSequence, operations_json AS operationsJson FROM ${OUTBOX_TABLE} ORDER BY actor_sequence`,
		)
		.map(({ actorSequence, operationsJson }) =>
			parseMutation({
				actorId,
				actorSequence,
				operations: JSON.parse(operationsJson),
			}),
		);
}

function assertPullPage(
	request: PullRequest,
	response: Extract<
		ReturnType<typeof parsePullResponse>,
		{ ok: true; snapshotRequired: false }
	>,
	outbox: readonly Mutation[],
	actorId: string,
): void {
	if (response.fromCursor !== request.cursor) {
		throw new Error('Replica pull response does not echo the requested cursor');
	}
	let expected = request.cursor;
	const pending = new Map(
		outbox.map((mutation) => [mutation.actorSequence, mutation]),
	);
	for (const mutation of response.mutations) {
		expected += 1;
		if (mutation.serverSequence !== expected) {
			throw new Error('Replica pull response is not a contiguous server page');
		}
		if (mutation.actorId === actorId) {
			const local = pending.get(mutation.actorSequence);
			if (
				!local ||
				stableJson(local.operations) !== stableJson(mutation.operations)
			) {
				throw new Error(
					'Replica authority returned a mismatched mutation echo',
				);
			}
		}
	}
	if (response.newCursor !== expected) {
		throw new Error(
			'Replica pull response cursor does not match its mutations',
		);
	}
	if (response.hasMore && response.mutations.length === 0) {
		throw new Error('Replica pull response cannot make progress');
	}
}

function parseStagedChunk(chunkJson: string): SnapshotChunk {
	const response = parseSnapshotChunkResponse({
		kind: 'snapshotChunk',
		ok: true,
		chunk: JSON.parse(chunkJson),
	});
	if (!response.ok) throw new Error('Staged replica snapshot chunk is invalid');
	return response.chunk;
}

function readStagedChunk(
	sqlite: RecordSyncSqlite,
	index: number,
): SnapshotChunk | undefined {
	const row = sqlite.all<{ chunkJson: string }>(
		`SELECT chunk_json AS chunkJson FROM ${SNAPSHOT_CHUNK_TABLE} WHERE chunk_index = ?`,
		[index],
	)[0];
	if (!row) return undefined;
	try {
		return parseStagedChunk(row.chunkJson);
	} catch {
		sqlite.run(`DELETE FROM ${SNAPSHOT_CHUNK_TABLE} WHERE chunk_index = ?`, [
			index,
		]);
		return undefined;
	}
}

function parseStagedManifest(manifestJson: string): SnapshotManifest {
	const response = parsePullResponse({
		kind: 'pull',
		ok: true,
		snapshotRequired: true,
		manifest: JSON.parse(manifestJson),
	});
	if (!response.ok || !response.snapshotRequired) {
		throw new Error('Staged replica snapshot manifest is invalid');
	}
	return response.manifest;
}

function readStagedManifest(
	sqlite: RecordSyncSqlite,
): SnapshotManifest | undefined {
	const row = sqlite.all<{ manifestJson: string }>(
		`SELECT manifest_json AS manifestJson FROM ${SNAPSHOT_TABLE} WHERE id = 1`,
	)[0];
	if (!row) return undefined;
	try {
		return parseStagedManifest(row.manifestJson);
	} catch {
		sqlite.transaction(() => {
			sqlite.run(`DELETE FROM ${SNAPSHOT_CHUNK_TABLE}`);
			sqlite.run(`DELETE FROM ${SNAPSHOT_TABLE}`);
		});
		return undefined;
	}
}

function validateSnapshotActorHighWater(
	meta: ReplicaMeta,
	outbox: readonly Mutation[],
	acceptedThrough: number,
): number {
	if (!Number.isSafeInteger(acceptedThrough) || acceptedThrough < 0) {
		throw new Error('Replica snapshot actor high-water is invalid');
	}
	const firstPending = outbox[0]?.actorSequence ?? meta.nextActorSequence;
	let expected = firstPending;
	for (const mutation of outbox) {
		if (mutation.actorSequence !== expected) {
			throw new Error('Replica outbox is not a contiguous actor suffix');
		}
		expected += 1;
	}
	if (expected !== meta.nextActorSequence) {
		throw new Error('Replica outbox does not end at the next actor sequence');
	}
	const previouslyAcceptedThrough = firstPending - 1;
	const lastAllocated = meta.nextActorSequence - 1;
	if (
		acceptedThrough < previouslyAcceptedThrough ||
		acceptedThrough > lastAllocated
	) {
		throw new Error(
			'Replica snapshot actor high-water contradicts local intent',
		);
	}
	return acceptedThrough;
}

function stableJson(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, sortJson(child)]),
		);
	}
	return value;
}

function assertPositiveInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new TypeError(`${label} must be a positive safe integer`);
	}
}

function assertNonEmpty(value: string, label: string): void {
	if (value.trim() === '') throw new TypeError(`${label} must not be empty`);
}

function parseDatabaseBinding(value: unknown): ReplicaDatabaseBinding {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		Object.keys(value).length !== 1 ||
		!Object.hasOwn(value, 'databaseIncarnationId') ||
		typeof (value as { databaseIncarnationId?: unknown })
			.databaseIncarnationId !== 'string'
	) {
		throw new TypeError('Invalid replica database binding response');
	}
	return value as ReplicaDatabaseBinding;
}
