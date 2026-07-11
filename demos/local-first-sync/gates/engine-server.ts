import { Database } from 'bun:sqlite';
import {
	type LogicalState,
	type Operation,
	type PullRequest,
	type PullResponse,
	type PushRequest,
	type PushResponse,
	requestRefusal,
	rowKey,
	type SnapshotChunk,
	type SnapshotChunkRequest,
	type SnapshotChunkResponse,
	type SnapshotManifest,
	type SnapshotRow,
} from './protocol';
import { createSnapshotChunk, createSnapshotManifest } from './snapshot-codec';

type StoredRow = { cells_json: string; deleted: number };

export class SqliteServer {
	readonly db: Database;

	constructor(path: string) {
		this.db = new Database(path, { create: true });
		this.db.run('PRAGMA journal_mode = WAL');
		this.db.run(`
			CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS actor_high_water (actor_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS mutation_log (
				server_sequence INTEGER PRIMARY KEY,
				actor_id TEXT NOT NULL,
				actor_sequence INTEGER NOT NULL,
				operations_json TEXT NOT NULL,
				UNIQUE(actor_id, actor_sequence)
			);
			CREATE TABLE IF NOT EXISTS canonical_rows (
				table_name TEXT NOT NULL,
				row_id TEXT NOT NULL,
				cells_json TEXT NOT NULL,
				deleted INTEGER NOT NULL,
				PRIMARY KEY(table_name, row_id)
			);
			INSERT OR IGNORE INTO sync_meta(key, value) VALUES ('server_sequence', 0);
			INSERT OR IGNORE INTO sync_meta(key, value) VALUES ('watermark', 0);
			INSERT OR IGNORE INTO sync_meta(key, value) VALUES ('snapshot_generation', 0);
			CREATE TABLE IF NOT EXISTS snapshot_manifest (
				id INTEGER PRIMARY KEY CHECK(id = 1),
				manifest_json TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS snapshot_chunks (
				chunk_index INTEGER PRIMARY KEY,
				generation INTEGER NOT NULL,
				rows_json TEXT NOT NULL,
				checksum TEXT NOT NULL
			);
		`);
	}

	close(): void {
		this.db.close();
	}

	private apply(operation: Operation): void {
		const stored = this.db
			.query<StoredRow, [string, string]>(
				'SELECT cells_json, deleted FROM canonical_rows WHERE table_name = ? AND row_id = ?',
			)
			.get(operation.table, operation.rowId);
		if (operation.kind === 'deleteRow') {
			this.db.run(
				`INSERT INTO canonical_rows(table_name, row_id, cells_json, deleted) VALUES (?, ?, '{}', 1)
				 ON CONFLICT(table_name, row_id) DO UPDATE SET cells_json = '{}', deleted = 1`,
				[operation.table, operation.rowId],
			);
			return;
		}
		if (stored?.deleted) return;
		const cells = stored
			? (JSON.parse(stored.cells_json) as Record<string, unknown>)
			: {};
		for (const [field, value] of Object.entries(operation.cells)) {
			if (value === null) delete cells[field];
			else cells[field] = value;
		}
		this.db.run(
			`INSERT INTO canonical_rows(table_name, row_id, cells_json, deleted) VALUES (?, ?, ?, 0)
			 ON CONFLICT(table_name, row_id) DO UPDATE SET cells_json = excluded.cells_json, deleted = 0`,
			[operation.table, operation.rowId, JSON.stringify(cells)],
		);
	}

	push(
		request: PushRequest,
		acceptLimit = Number.POSITIVE_INFINITY,
		failAfterOperation?: number,
	): PushResponse {
		const refusal = requestRefusal(request);
		if (refusal) return { kind: 'push', ok: false, reason: refusal };
		let response: PushResponse = { kind: 'push', ok: true };
		const transaction = this.db.transaction(() => {
			let accepted = 0;
			let appliedOperations = 0;
			for (const mutation of request.mutations) {
				if (accepted >= acceptLimit) break;
				const highWater =
					this.db
						.query<{ sequence: number }, [string]>(
							'SELECT sequence FROM actor_high_water WHERE actor_id = ?',
						)
						.get(mutation.actorId)?.sequence ?? 0;
				if (mutation.actorSequence <= highWater) continue;
				if (mutation.actorSequence !== highWater + 1) {
					response = { kind: 'push', ok: false, reason: 'actor-sequence-gap' };
					return;
				}
				const next =
					(this.db
						.query<{ value: number }, []>(
							"SELECT value FROM sync_meta WHERE key = 'server_sequence'",
						)
						.get()?.value ?? 0) + 1;
				for (const operation of mutation.operations) {
					this.apply(operation);
					appliedOperations += 1;
					if (appliedOperations === failAfterOperation)
						throw new Error('injected server crash');
				}
				this.db.run('INSERT INTO mutation_log VALUES (?, ?, ?, ?)', [
					next,
					mutation.actorId,
					mutation.actorSequence,
					JSON.stringify(mutation.operations),
				]);
				this.db.run(
					'INSERT INTO actor_high_water VALUES (?, ?) ON CONFLICT(actor_id) DO UPDATE SET sequence = excluded.sequence',
					[mutation.actorId, mutation.actorSequence],
				);
				this.db.run(
					"UPDATE sync_meta SET value = ? WHERE key = 'server_sequence'",
					[next],
				);
				accepted += 1;
			}
			response = { kind: 'push', ok: true };
		});
		transaction.immediate();
		return response;
	}

	pull(request: PullRequest): PullResponse {
		const refusal = requestRefusal(request);
		if (refusal) return { kind: 'pull', ok: false, reason: refusal };
		const watermark = this.meta('watermark');
		if (request.cursor < watermark) {
			const stored = this.db
				.query<{ manifest_json: string }, []>(
					'SELECT manifest_json FROM snapshot_manifest WHERE id = 1',
				)
				.get();
			if (!stored) throw new Error('watermark has no published snapshot');
			return {
				kind: 'pull',
				ok: true,
				snapshotRequired: true,
				manifest: JSON.parse(stored.manifest_json),
			};
		}
		const rows = this.db
			.query<
				{
					server_sequence: number;
					actor_id: string;
					actor_sequence: number;
					operations_json: string;
				},
				[number, number]
			>(
				'SELECT * FROM mutation_log WHERE server_sequence > ? ORDER BY server_sequence LIMIT ?',
			)
			.all(request.cursor, request.limit);
		const mutations = rows.map((row) => ({
			serverSequence: row.server_sequence,
			actorId: row.actor_id,
			actorSequence: row.actor_sequence,
			operations: JSON.parse(row.operations_json) as Operation[],
		}));
		const head =
			this.db
				.query<{ value: number }, []>(
					"SELECT value FROM sync_meta WHERE key = 'server_sequence'",
				)
				.get()?.value ?? 0;
		const newCursor = mutations.at(-1)?.serverSequence ?? request.cursor;
		return {
			kind: 'pull',
			ok: true,
			snapshotRequired: false,
			fromCursor: request.cursor,
			mutations,
			newCursor,
			hasMore: newCursor < head,
		};
	}

	publishSnapshot(
		rowsPerChunk: number,
		failBeforeCommit = false,
	): SnapshotManifest {
		if (!Number.isSafeInteger(rowsPerChunk) || rowsPerChunk < 1)
			throw new Error('rowsPerChunk must be a positive integer');
		let published: SnapshotManifest | null = null;
		this.db
			.transaction(() => {
				const generation = this.meta('snapshot_generation') + 1;
				const snapshotSequence = this.meta('server_sequence');
				const rows = this.db
					.query<
						{
							table_name: string;
							row_id: string;
							cells_json: string;
							deleted: number;
						},
						[]
					>('SELECT * FROM canonical_rows ORDER BY table_name, row_id')
					.all()
					.map(
						(row): SnapshotRow => ({
							table: row.table_name,
							rowId: row.row_id,
							deleted: Boolean(row.deleted),
							cells: JSON.parse(row.cells_json),
						}),
					);
				const rowPages: SnapshotRow[][] = [];
				for (let start = 0; start < rows.length; start += rowsPerChunk)
					rowPages.push(rows.slice(start, start + rowsPerChunk));
				if (rowPages.length === 0) rowPages.push([]);
				const chunks = rowPages.map((page, index) =>
					createSnapshotChunk(generation, index, page),
				);
				const actorHighWater = Object.fromEntries(
					this.db
						.query<{ actor_id: string; sequence: number }, []>(
							'SELECT * FROM actor_high_water ORDER BY actor_id',
						)
						.all()
						.map((row) => [row.actor_id, row.sequence]),
				);
				published = createSnapshotManifest({
					generation,
					snapshotSequence,
					chunkChecksums: chunks.map(({ checksum }) => checksum),
					actorHighWater,
				});
				this.db.run('DELETE FROM snapshot_chunks');
				for (const chunk of chunks)
					this.db.run('INSERT INTO snapshot_chunks VALUES (?, ?, ?, ?)', [
						chunk.index,
						chunk.generation,
						JSON.stringify(chunk.rows),
						chunk.checksum,
					]);
				this.db.run(
					'INSERT INTO snapshot_manifest VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET manifest_json = excluded.manifest_json',
					[JSON.stringify(published)],
				);
				this.db.run("UPDATE sync_meta SET value = ? WHERE key = 'watermark'", [
					snapshotSequence,
				]);
				this.db.run(
					"UPDATE sync_meta SET value = ? WHERE key = 'snapshot_generation'",
					[generation],
				);
				this.db.run('DELETE FROM mutation_log WHERE server_sequence <= ?', [
					snapshotSequence,
				]);
				if (failBeforeCommit)
					throw new Error('injected snapshot publication crash');
			})
			.immediate();
		if (!published) throw new Error('snapshot transaction did not publish');
		return published;
	}

	snapshotChunk(request: SnapshotChunkRequest): SnapshotChunkResponse {
		const refusal = requestRefusal(request);
		if (refusal) return { kind: 'snapshotChunk', ok: false, reason: refusal };
		const manifest = this.currentManifest();
		if (!manifest || manifest.generation !== request.generation)
			return { kind: 'snapshotChunk', ok: false, reason: 'snapshot-replaced' };
		const stored = this.db
			.query<
				{ generation: number; rows_json: string; checksum: string },
				[number]
			>(
				'SELECT generation, rows_json, checksum FROM snapshot_chunks WHERE chunk_index = ?',
			)
			.get(request.index);
		if (!stored)
			return { kind: 'snapshotChunk', ok: false, reason: 'chunk-out-of-range' };
		return {
			kind: 'snapshotChunk',
			ok: true,
			chunk: {
				generation: stored.generation,
				index: request.index,
				rows: JSON.parse(stored.rows_json),
				checksum: stored.checksum,
			},
		};
	}

	private meta(key: string): number {
		const row = this.db
			.query<{ value: number }, [string]>(
				'SELECT value FROM sync_meta WHERE key = ?',
			)
			.get(key);
		if (!row) throw new Error(`missing server metadata: ${key}`);
		return row.value;
	}

	private currentManifest(): SnapshotManifest | null {
		const row = this.db
			.query<{ manifest_json: string }, []>(
				'SELECT manifest_json FROM snapshot_manifest WHERE id = 1',
			)
			.get();
		return row ? JSON.parse(row.manifest_json) : null;
	}

	dump() {
		const canonical: LogicalState = {};
		for (const row of this.db
			.query<
				{
					table_name: string;
					row_id: string;
					cells_json: string;
					deleted: number;
				},
				[]
			>('SELECT * FROM canonical_rows ORDER BY table_name, row_id')
			.all()) {
			canonical[rowKey(row.table_name, row.row_id)] = {
				deleted: Boolean(row.deleted),
				cells: JSON.parse(row.cells_json),
			};
		}
		const actorHighWater = Object.fromEntries(
			this.db
				.query<{ actor_id: string; sequence: number }, []>(
					'SELECT * FROM actor_high_water ORDER BY actor_id',
				)
				.all()
				.map((row) => [row.actor_id, row.sequence]),
		);
		const log = this.db
			.query<
				{
					server_sequence: number;
					actor_id: string;
					actor_sequence: number;
					operations_json: string;
				},
				[]
			>('SELECT * FROM mutation_log ORDER BY server_sequence')
			.all()
			.map((row) => ({
				serverSequence: row.server_sequence,
				actorId: row.actor_id,
				actorSequence: row.actor_sequence,
				operations: JSON.parse(row.operations_json) as Operation[],
			}));
		const chunks: SnapshotChunk[] = this.db
			.query<
				{
					chunk_index: number;
					generation: number;
					rows_json: string;
					checksum: string;
				},
				[]
			>('SELECT * FROM snapshot_chunks ORDER BY chunk_index')
			.all()
			.map((row) => ({
				generation: row.generation,
				index: row.chunk_index,
				rows: JSON.parse(row.rows_json),
				checksum: row.checksum,
			}));
		return {
			serverSequence: this.meta('server_sequence'),
			watermark: this.meta('watermark'),
			canonical,
			actorHighWater,
			log,
			manifest: this.currentManifest(),
			chunks,
		};
	}
}
