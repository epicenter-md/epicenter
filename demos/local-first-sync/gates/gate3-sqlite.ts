import { Database } from 'bun:sqlite';
import {
	areRowsCanonical,
	type CandidateChunk,
	type CandidateManifest,
	canonicalRows,
	type DatabaseStatus,
	exceedsCandidateLimits,
	type Gate3Authority,
	isValidCandidateChunk,
	isValidCandidateManifest,
} from './gate3-protocol.js';
import type { Cells, Operation, SnapshotRow } from './protocol.js';
import { stableJson } from './util.js';

type StoredDatabase = {
	id: string;
	schema_hash: string;
	status: DatabaseStatus;
	head: number;
};

type StoredUpload = {
	manifest: CandidateManifest;
	sealed: boolean;
};

/** Independent SQLite implementation of the one-slot succession state machine. */
export function createGate3Sqlite(
	path: string,
	initial: { databaseId: string; schemaHash: string; rows: SnapshotRow[] },
) {
	const database = new Database(path, { create: true, strict: true });
	database.exec('PRAGMA journal_mode = WAL');
	database.exec(`
		CREATE TABLE IF NOT EXISTS gate3_family (
			id INTEGER PRIMARY KEY CHECK(id = 1),
			current_database_id TEXT NOT NULL,
			staged_database_id TEXT
		);
		CREATE TABLE IF NOT EXISTS gate3_databases (
			id TEXT PRIMARY KEY,
			schema_hash TEXT NOT NULL,
			status TEXT NOT NULL,
			head INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS gate3_rows (
			database_id TEXT NOT NULL,
			table_name TEXT NOT NULL,
			row_id TEXT NOT NULL,
			cells_json TEXT NOT NULL,
			PRIMARY KEY(database_id, table_name, row_id)
		);
		CREATE TABLE IF NOT EXISTS gate3_manifests (
			candidate_id TEXT PRIMARY KEY,
			manifest_json TEXT NOT NULL,
			sealed INTEGER NOT NULL CHECK(sealed IN (0, 1))
		);
		CREATE TABLE IF NOT EXISTS gate3_chunks (
			candidate_id TEXT NOT NULL,
			chunk_index INTEGER NOT NULL,
			chunk_json TEXT NOT NULL,
			PRIMARY KEY(candidate_id, chunk_index)
		);
	`);

	function transaction<TResult>(run: () => TResult): TResult {
		return database.transaction(run).immediate();
	}

	if (!readFamily()) {
		transaction(() => {
			database.run('INSERT INTO gate3_family VALUES (1, ?, NULL)', [
				initial.databaseId,
			]);
			database.run('INSERT INTO gate3_databases VALUES (?, ?, ?, 0)', [
				initial.databaseId,
				initial.schemaHash,
				'live',
			]);
			writeRows(initial.databaseId, canonicalRows(initial.rows));
		});
	}

	function readFamily():
		| { currentDatabaseId: string; stagedDatabaseId: string | null }
		| undefined {
		const row = database
			.query<
				{ current_database_id: string; staged_database_id: string | null },
				[]
			>('SELECT current_database_id, staged_database_id FROM gate3_family')
			.get();
		return row
			? {
					currentDatabaseId: row.current_database_id,
					stagedDatabaseId: row.staged_database_id,
				}
			: undefined;
	}

	function readDatabase(databaseId: string): StoredDatabase | undefined {
		return database
			.query<StoredDatabase, [string]>(
				'SELECT id, schema_hash, status, head FROM gate3_databases WHERE id = ?',
			)
			.get(databaseId);
	}

	function readRows(databaseId: string): SnapshotRow[] {
		return database
			.query<
				{ table_name: string; row_id: string; cells_json: string },
				[string]
			>(
				`SELECT table_name, row_id, cells_json FROM gate3_rows
				 WHERE database_id = ? ORDER BY table_name, row_id`,
			)
			.all(databaseId)
			.map((row) => ({
				table: row.table_name,
				rowId: row.row_id,
				cells: JSON.parse(row.cells_json),
			}));
	}

	function writeRows(databaseId: string, rows: readonly SnapshotRow[]): void {
		for (const row of rows)
			database.run('INSERT INTO gate3_rows VALUES (?, ?, ?, ?)', [
				databaseId,
				row.table,
				row.rowId,
				JSON.stringify(row.cells),
			]);
	}

	function readUpload(candidateId: string): StoredUpload | undefined {
		const row = database
			.query<{ manifest_json: string; sealed: number }, [string]>(
				'SELECT manifest_json, sealed FROM gate3_manifests WHERE candidate_id = ?',
			)
			.get(candidateId);
		return row
			? { manifest: JSON.parse(row.manifest_json), sealed: row.sealed === 1 }
			: undefined;
	}

	function readChunks(candidateId: string): CandidateChunk[] {
		return database
			.query<{ chunk_json: string }, [string]>(
				`SELECT chunk_json FROM gate3_chunks
				 WHERE candidate_id = ? ORDER BY chunk_index`,
			)
			.all(candidateId)
			.map(({ chunk_json }) => JSON.parse(chunk_json));
	}

	function removeStaged(candidateId: string): void {
		database.run('DELETE FROM gate3_chunks WHERE candidate_id = ?', [
			candidateId,
		]);
		database.run('DELETE FROM gate3_manifests WHERE candidate_id = ?', [
			candidateId,
		]);
		database.run(
			`UPDATE gate3_family SET staged_database_id = NULL
			 WHERE staged_database_id = ?`,
			[candidateId],
		);
	}

	const authority: Gate3Authority = {
		sourceSnapshot() {
			return transaction(() => {
				const family = readFamily();
				if (!family) throw new Error('family is missing');
				const current = readDatabase(family.currentDatabaseId);
				if (!current) throw new Error('current database is missing');
				return {
					databaseId: current.id,
					schemaHash: current.schema_hash,
					head: current.head,
					rows: readRows(current.id),
				};
			});
		},
		stage(manifest) {
			if (!isValidCandidateManifest(manifest))
				return { ok: false, reason: 'invalid-manifest' };
			if (exceedsCandidateLimits(manifest))
				return { ok: false, reason: 'candidate-too-large' };
			return transaction(() => {
				const family = readFamily();
				if (!family) throw new Error('family is missing');
				if (readDatabase(manifest.candidateId))
					return { ok: false, reason: 'candidate-already-exists' };
				if (manifest.sourceDatabaseId !== family.currentDatabaseId)
					return { ok: false, reason: 'wrong-source' };
				if (family.stagedDatabaseId === manifest.candidateId) {
					const stored = readUpload(manifest.candidateId);
					if (!stored || stableJson(stored.manifest) !== stableJson(manifest))
						throw new Error('content-addressed manifest state is corrupt');
					return {
						ok: true,
						candidateId: manifest.candidateId,
						replaced: false,
					};
				}
				const replaced = family.stagedDatabaseId !== null;
				if (family.stagedDatabaseId) removeStaged(family.stagedDatabaseId);
				database.run('INSERT INTO gate3_manifests VALUES (?, ?, 0)', [
					manifest.candidateId,
					JSON.stringify(manifest),
				]);
				database.run(
					'UPDATE gate3_family SET staged_database_id = ? WHERE id = 1',
					[manifest.candidateId],
				);
				return {
					ok: true,
					candidateId: manifest.candidateId,
					replaced,
				};
			});
		},
		upload(candidateId, chunk) {
			return transaction(() => {
				const family = readFamily();
				if (family?.stagedDatabaseId !== candidateId)
					return { ok: false, reason: 'candidate-not-staged' };
				const upload = readUpload(candidateId);
				if (!upload) throw new Error('staged candidate state is incomplete');
				const expected = upload.manifest.chunks[chunk.index];
				if (!expected) return { ok: false, reason: 'chunk-out-of-range' };
				if (!isValidCandidateChunk(expected, chunk))
					return { ok: false, reason: 'invalid-chunk' };
				database.run('INSERT OR IGNORE INTO gate3_chunks VALUES (?, ?, ?)', [
					candidateId,
					chunk.index,
					JSON.stringify(chunk),
				]);
				return { ok: true };
			});
		},
		seal(candidateId) {
			return transaction(() => {
				const family = readFamily();
				if (family?.stagedDatabaseId !== candidateId)
					return { ok: false, reason: 'candidate-not-staged' };
				const upload = readUpload(candidateId);
				if (!upload) throw new Error('staged candidate state is incomplete');
				if (upload.sealed) return { ok: true };
				const chunks = readChunks(candidateId);
				if (chunks.length !== upload.manifest.chunks.length)
					return { ok: false, reason: 'missing-chunks' };
				const rows = chunks.flatMap((chunk) => chunk.rows);
				if (!areRowsCanonical(rows))
					return { ok: false, reason: 'rows-not-canonical' };
				database.run(
					'UPDATE gate3_manifests SET sealed = 1 WHERE candidate_id = ?',
					[candidateId],
				);
				return { ok: true };
			});
		},
		activate(candidateId) {
			return transaction(() => {
				const family = readFamily();
				if (!family) throw new Error('family is missing');
				if (family.currentDatabaseId === candidateId)
					return { ok: true, status: 'already-active' };
				if (family.stagedDatabaseId !== candidateId)
					return { ok: false, reason: 'candidate-not-staged' };
				const upload = readUpload(candidateId);
				if (!upload) throw new Error('staged candidate state is incomplete');
				if (!upload.sealed)
					return { ok: false, reason: 'candidate-not-sealed' };
				const { manifest } = upload;
				const source = readDatabase(manifest.sourceDatabaseId);
				if (
					family.currentDatabaseId !== manifest.sourceDatabaseId ||
					!source ||
					source.head !== manifest.sourceHead
				)
					return { ok: false, reason: 'stale-head' };
				database.run(
					"UPDATE gate3_databases SET status = 'fenced' WHERE id = ?",
					[source.id],
				);
				database.run('INSERT INTO gate3_databases VALUES (?, ?, ?, 0)', [
					candidateId,
					manifest.targetSchemaHash,
					'live',
				]);
				writeRows(
					candidateId,
					readChunks(candidateId).flatMap((chunk) => chunk.rows),
				);
				database.run(
					`UPDATE gate3_family SET current_database_id = ?, staged_database_id = NULL
					 WHERE id = 1`,
					[candidateId],
				);
				database.run('DELETE FROM gate3_manifests WHERE candidate_id = ?', [
					candidateId,
				]);
				return { ok: true, status: 'activated' };
			});
		},
		discard(candidateId) {
			return transaction(() => {
				const family = readFamily();
				if (family?.stagedDatabaseId !== candidateId)
					return { ok: false, reason: 'candidate-not-staged' };
				removeStaged(candidateId);
				return { ok: true };
			});
		},
		write(databaseId, operation) {
			return transaction(() => {
				const family = readFamily();
				const target = readDatabase(databaseId);
				if (target?.status === 'fenced')
					return { ok: false, reason: 'database-fenced' };
				if (
					!family ||
					!target ||
					target.status !== 'live' ||
					family.currentDatabaseId !== databaseId
				)
					return { ok: false, reason: 'database-not-live' };
				if (!apply(databaseId, operation))
					return { ok: false, reason: 'create-conflict' };
				const head = target.head + 1;
				database.run('UPDATE gate3_databases SET head = ? WHERE id = ?', [
					head,
					databaseId,
				]);
				return { ok: true, head };
			});
		},
		readDatabase(databaseId) {
			return transaction(() => {
				const stored = readDatabase(databaseId);
				if (!stored) return { ok: false, reason: 'database-not-readable' };
				return {
					ok: true,
					snapshot: {
						databaseId,
						schemaHash: stored.schema_hash,
						head: stored.head,
						rows: readRows(databaseId),
					},
				};
			});
		},
		checkpointChunks(databaseId) {
			return transaction(() => {
				const stored = readDatabase(databaseId);
				if (!stored) return null;
				const chunks = readChunks(databaseId);
				return chunks.length > 0 ? chunks : null;
			});
		},
		dump() {
			const family = readFamily();
			if (!family) throw new Error('family is missing');
			const storedDatabases = database
				.query<StoredDatabase, []>(
					'SELECT id, schema_hash, status, head FROM gate3_databases ORDER BY id',
				)
				.all();
			const staged = family.stagedDatabaseId
				? readUpload(family.stagedDatabaseId)
				: undefined;
			if (family.stagedDatabaseId && !staged)
				throw new Error('staged candidate state is incomplete');
			return {
				currentDatabaseId: family.currentDatabaseId,
				stagedUpload:
					staged && family.stagedDatabaseId
						? {
								manifest: staged.manifest,
								sealed: staged.sealed,
								chunks: readChunks(family.stagedDatabaseId),
							}
						: null,
				databases: storedDatabases.map((stored) => ({
					id: stored.id,
					schemaHash: stored.schema_hash,
					status: stored.status,
					head: stored.head,
					rows: readRows(stored.id),
				})),
				checkpoints: storedDatabases.flatMap((stored) => {
					const chunks = readChunks(stored.id);
					return chunks.length > 0 ? [{ databaseId: stored.id, chunks }] : [];
				}),
			};
		},
	};

	return {
		...authority,
		close(): void {
			database.close();
		},
	};

	function apply(databaseId: string, operation: Operation): boolean {
		if (operation.kind === 'deleteRow') {
			database.run(
				`DELETE FROM gate3_rows
				 WHERE database_id = ? AND table_name = ? AND row_id = ?`,
				[databaseId, operation.table, operation.rowId],
			);
			return true;
		}
		const stored = database
			.query<{ cells_json: string }, [string, string, string]>(
				`SELECT cells_json FROM gate3_rows
				 WHERE database_id = ? AND table_name = ? AND row_id = ?`,
			)
			.get(databaseId, operation.table, operation.rowId);
		if (operation.kind === 'createRow') {
			if (stored) return false;
			const cells: Cells = {};
			for (const [field, value] of Object.entries(operation.cells))
				if (value !== null) cells[field] = value;
			database.run('INSERT INTO gate3_rows VALUES (?, ?, ?, ?)', [
				databaseId,
				operation.table,
				operation.rowId,
				JSON.stringify(cells),
			]);
			return true;
		}
		if (!stored) return true;
		const cells: Cells = JSON.parse(stored.cells_json);
		for (const [field, value] of Object.entries(operation.cells)) {
			if (value === null) delete cells[field];
			else cells[field] = value;
		}
		database.run(
			`UPDATE gate3_rows SET cells_json = ?
			 WHERE database_id = ? AND table_name = ? AND row_id = ?`,
			[JSON.stringify(cells), databaseId, operation.table, operation.rowId],
		);
		return true;
	}
}
