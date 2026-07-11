import { Database } from 'bun:sqlite';
import {
	type ClientDump,
	ENVELOPE,
	type LogicalState,
	type Mutation,
	type Operation,
	type PullResponse,
	type RequestEnvelope,
	type RowKey,
	rowKey,
	type SnapshotChunk,
	type SnapshotInstallResult,
	type SnapshotManifest,
	type SnapshotRow,
} from './protocol';
import {
	isValidSnapshotChunk,
	isValidSnapshotManifest,
} from './snapshot-codec';

/** Candidate B: typed application tables are the only live materialization. */
export class SqliteClientB {
	readonly db: Database;
	private envelope: RequestEnvelope;
	constructor(
		path: string,
		readonly actorId: string,
		envelope: RequestEnvelope = ENVELOPE,
	) {
		this.envelope = structuredClone(envelope);
		this.db = new Database(path, { create: true });
		this.db.run('PRAGMA journal_mode = WAL');
		this.db.run(`
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS outbox (actor_sequence INTEGER PRIMARY KEY, operations_json TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, pinned INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS quarantine (table_name TEXT, row_id TEXT, cells_json TEXT NOT NULL, PRIMARY KEY(table_name,row_id));
			CREATE TABLE IF NOT EXISTS tombstones (table_name TEXT, row_id TEXT, PRIMARY KEY(table_name,row_id));
			CREATE TABLE IF NOT EXISTS snapshot_stage (chunk_index INTEGER PRIMARY KEY, generation INTEGER NOT NULL, rows_json TEXT NOT NULL, checksum TEXT NOT NULL);
			INSERT OR IGNORE INTO meta VALUES ('next_actor_sequence', '1');
			INSERT OR IGNORE INTO meta VALUES ('pull_cursor', '0');
		`);
		this.db.run('INSERT OR IGNORE INTO meta VALUES (?, ?)', [
			'actor_id',
			actorId,
		]);
		for (const [key, value] of Object.entries(this.envelope))
			this.db.run('INSERT OR IGNORE INTO meta VALUES (?, ?)', [
				key,
				String(value),
			]);
		const storedActor = this.meta('actor_id');
		if (storedActor !== actorId)
			throw new Error(`actor mismatch: ${storedActor} != ${actorId}`);
		for (const [key, value] of Object.entries(this.envelope))
			if (this.meta(key) !== String(value))
				throw new Error(`client identity mismatch for ${key}`);
	}
	close(): void {
		this.db.close();
	}
	private meta(key: string): string {
		const row = this.db
			.query<{ value: string }, [string]>(
				'SELECT value FROM meta WHERE key = ?',
			)
			.get(key);
		if (!row) throw new Error(`missing client metadata: ${key}`);
		return row.value;
	}
	private setMeta(key: string, value: string | number): void {
		this.db.run('UPDATE meta SET value = ? WHERE key = ?', [
			String(value),
			key,
		]);
	}
	private optionalMeta(key: string): string | null {
		return (
			this.db
				.query<{ value: string }, [string]>(
					'SELECT value FROM meta WHERE key = ?',
				)
				.get(key)?.value ?? null
		);
	}
	private upsertMeta(key: string, value: string): void {
		this.db.run(
			'INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
			[key, value],
		);
	}
	private outbox(): Mutation[] {
		return this.db
			.query<{ actor_sequence: number; operations_json: string }, []>(
				'SELECT * FROM outbox ORDER BY actor_sequence',
			)
			.all()
			.map((row) => ({
				actorId: this.actorId,
				actorSequence: row.actor_sequence,
				operations: JSON.parse(row.operations_json),
			}));
	}
	private read(
		table: string,
		id: string,
	):
		| {
				deleted: boolean;
				cells: Record<string, string | number | boolean | null>;
		  }
		| undefined {
		if (
			this.db
				.query<{ one: number }, [string, string]>(
					'SELECT 1 one FROM tombstones WHERE table_name=? AND row_id=?',
				)
				.get(table, id)
		)
			return { deleted: true, cells: {} };
		if (table === 'notes') {
			const row = this.db
				.query<{ title: string; pinned: number }, [string]>(
					'SELECT title,pinned FROM notes WHERE id=?',
				)
				.get(id);
			if (row)
				return {
					deleted: false,
					cells: { title: row.title, pinned: Boolean(row.pinned) },
				};
		}
		if (table === 'folders') {
			const row = this.db
				.query<{ name: string }, [string]>(
					'SELECT name FROM folders WHERE id=?',
				)
				.get(id);
			if (row) return { deleted: false, cells: { name: row.name } };
		}
		const row = this.db
			.query<{ cells_json: string }, [string, string]>(
				'SELECT cells_json FROM quarantine WHERE table_name=? AND row_id=?',
			)
			.get(table, id);
		if (row) return { deleted: false, cells: JSON.parse(row.cells_json) };
	}
	private materialize(
		table: string,
		id: string,
		cells: Record<string, string | number | boolean | null>,
	): void {
		if (table === 'notes') this.db.run('DELETE FROM notes WHERE id=?', [id]);
		else if (table === 'folders')
			this.db.run('DELETE FROM folders WHERE id=?', [id]);
		this.db.run('DELETE FROM quarantine WHERE table_name=? AND row_id=?', [
			table,
			id,
		]);
		const fields = Object.keys(cells);
		if (
			table === 'notes' &&
			fields.every((field) => field === 'title' || field === 'pinned') &&
			typeof cells.title === 'string' &&
			typeof cells.pinned === 'boolean'
		)
			this.db.run('INSERT INTO notes VALUES (?,?,?)', [
				id,
				cells.title,
				Number(cells.pinned),
			]);
		else if (
			table === 'folders' &&
			fields.length === 1 &&
			typeof cells.name === 'string'
		)
			this.db.run('INSERT INTO folders VALUES (?,?)', [id, cells.name]);
		else
			this.db.run('INSERT INTO quarantine VALUES (?,?,?)', [
				table,
				id,
				JSON.stringify(cells),
			]);
	}
	private apply(operation: Operation): void {
		const existing = this.read(operation.table, operation.rowId);
		if (operation.kind === 'deleteRow') {
			if (operation.table === 'notes')
				this.db.run('DELETE FROM notes WHERE id=?', [operation.rowId]);
			else if (operation.table === 'folders')
				this.db.run('DELETE FROM folders WHERE id=?', [operation.rowId]);
			this.db.run('DELETE FROM quarantine WHERE table_name=? AND row_id=?', [
				operation.table,
				operation.rowId,
			]);
			this.db.run('INSERT OR IGNORE INTO tombstones VALUES (?,?)', [
				operation.table,
				operation.rowId,
			]);
			return;
		}
		if (existing?.deleted) return;
		const cells = existing?.cells ?? {};
		for (const [field, value] of Object.entries(operation.cells)) {
			if (value === null) delete cells[field];
			else cells[field] = value;
		}
		this.materialize(operation.table, operation.rowId, cells);
	}
	local(operations: Operation[], failBeforeCommit = false): void {
		this.db
			.transaction(() => {
				const sequence = Number(this.meta('next_actor_sequence'));
				this.db.run('INSERT INTO outbox VALUES (?,?)', [
					sequence,
					JSON.stringify(operations),
				]);
				this.setMeta('next_actor_sequence', sequence + 1);
				for (const operation of operations) this.apply(operation);
				if (failBeforeCommit) throw new Error('injected local crash');
			})
			.immediate();
	}
	pushRequest() {
		return {
			kind: 'push' as const,
			...this.envelope,
			mutations: this.outbox(),
		};
	}
	pullRequest(limit = 100) {
		return {
			kind: 'pull' as const,
			...this.envelope,
			cursor: Number(this.meta('pull_cursor')),
			limit,
		};
	}
	applyPull(response: PullResponse, failAfter?: number): boolean {
		if (
			!response.ok ||
			response.snapshotRequired ||
			response.fromCursor !== Number(this.meta('pull_cursor'))
		)
			return false;
		this.db
			.transaction(() => {
				let count = 0;
				for (const mutation of response.mutations) {
					for (const operation of mutation.operations) this.apply(operation);
					if (mutation.actorId === this.actorId)
						this.db.run('DELETE FROM outbox WHERE actor_sequence=?', [
							mutation.actorSequence,
						]);
					count++;
					if (count === failAfter) throw new Error('injected pull crash');
				}
				for (const mutation of this.outbox())
					for (const operation of mutation.operations) this.apply(operation);
				this.setMeta('pull_cursor', response.newCursor);
			})
			.immediate();
		return true;
	}
	beginSnapshot(manifest: SnapshotManifest): SnapshotInstallResult {
		if (!isValidSnapshotManifest(manifest))
			return { ok: false, reason: 'invalid-manifest' };
		if (manifest.snapshotSequence <= Number(this.meta('pull_cursor')))
			return { ok: false, reason: 'stale-snapshot' };
		const existing = this.optionalMeta('snapshot_manifest');
		if (existing) {
			try {
				if (
					(JSON.parse(existing) as SnapshotManifest).checksum ===
					manifest.checksum
				)
					return { ok: true };
			} catch {
				// A valid replacement manifest repairs corrupt abandoned staging.
			}
		}
		this.db
			.transaction(() => {
				this.db.run('DELETE FROM snapshot_stage');
				this.upsertMeta('snapshot_manifest', JSON.stringify(manifest));
			})
			.immediate();
		return { ok: true };
	}
	stageSnapshotChunk(chunk: SnapshotChunk): SnapshotInstallResult {
		const storedManifest = this.optionalMeta('snapshot_manifest');
		if (!storedManifest) return { ok: false, reason: 'wrong-generation' };
		let manifest: SnapshotManifest;
		try {
			manifest = JSON.parse(storedManifest) as SnapshotManifest;
		} catch {
			return { ok: false, reason: 'invalid-manifest' };
		}
		if (chunk.generation !== manifest.generation)
			return { ok: false, reason: 'wrong-generation' };
		if (
			chunk.index < 0 ||
			chunk.index >= manifest.chunkChecksums.length ||
			manifest.chunkChecksums[chunk.index] !== chunk.checksum ||
			!isValidSnapshotChunk(chunk)
		)
			return { ok: false, reason: 'invalid-chunk' };
		const existing = this.db
			.query<
				{ generation: number; rows_json: string; checksum: string },
				[number]
			>(
				'SELECT generation, rows_json, checksum FROM snapshot_stage WHERE chunk_index = ?',
			)
			.get(chunk.index);
		if (existing) {
			if (
				existing.generation !== chunk.generation ||
				existing.checksum !== chunk.checksum ||
				existing.rows_json !== JSON.stringify(chunk.rows)
			)
				return { ok: false, reason: 'invalid-chunk' };
			return { ok: true };
		}
		this.db.run('INSERT INTO snapshot_stage VALUES (?, ?, ?, ?)', [
			chunk.index,
			chunk.generation,
			JSON.stringify(chunk.rows),
			chunk.checksum,
		]);
		return { ok: true };
	}
	installSnapshot(failBeforeCommit = false): SnapshotInstallResult {
		const storedManifest = this.optionalMeta('snapshot_manifest');
		if (!storedManifest) return { ok: false, reason: 'incomplete-snapshot' };
		let manifest: SnapshotManifest;
		try {
			manifest = JSON.parse(storedManifest) as SnapshotManifest;
		} catch {
			return { ok: false, reason: 'invalid-manifest' };
		}
		if (!isValidSnapshotManifest(manifest))
			return { ok: false, reason: 'invalid-manifest' };
		if (manifest.snapshotSequence <= Number(this.meta('pull_cursor')))
			return { ok: false, reason: 'stale-snapshot' };
		const chunks = this.db
			.query<
				{
					chunk_index: number;
					generation: number;
					rows_json: string;
					checksum: string;
				},
				[]
			>('SELECT * FROM snapshot_stage ORDER BY chunk_index')
			.all();
		if (chunks.length !== manifest.chunkChecksums.length)
			return { ok: false, reason: 'incomplete-snapshot' };
		const rows: SnapshotRow[] = [];
		for (const [index, chunk] of chunks.entries()) {
			let chunkRows: SnapshotRow[];
			try {
				chunkRows = JSON.parse(chunk.rows_json) as SnapshotRow[];
			} catch {
				return { ok: false, reason: 'invalid-chunk' };
			}
			if (
				chunk.chunk_index !== index ||
				chunk.generation !== manifest.generation ||
				chunk.checksum !== manifest.chunkChecksums[index] ||
				!isValidSnapshotChunk({
					generation: chunk.generation,
					index: chunk.chunk_index,
					rows: chunkRows,
					checksum: chunk.checksum,
				})
			)
				return { ok: false, reason: 'invalid-chunk' };
			rows.push(...chunkRows);
		}
		this.db
			.transaction(() => {
				this.db.run('DELETE FROM notes');
				this.db.run('DELETE FROM folders');
				this.db.run('DELETE FROM quarantine');
				this.db.run('DELETE FROM tombstones');
				for (const row of rows) {
					if (row.deleted)
						this.db.run('INSERT INTO tombstones VALUES (?, ?)', [
							row.table,
							row.rowId,
						]);
					else this.materialize(row.table, row.rowId, row.cells);
				}
				if (failBeforeCommit)
					throw new Error('injected snapshot install crash');
				const acceptedThrough = manifest.actorHighWater[this.actorId] ?? 0;
				this.db.run('DELETE FROM outbox WHERE actor_sequence <= ?', [
					acceptedThrough,
				]);
				for (const mutation of this.outbox())
					for (const operation of mutation.operations) this.apply(operation);
				this.setMeta('pull_cursor', manifest.snapshotSequence);
				this.db.run('DELETE FROM snapshot_stage');
				this.db.run("DELETE FROM meta WHERE key = 'snapshot_manifest'");
			})
			.immediate();
		return { ok: true };
	}
	dump(): ClientDump {
		const rows: LogicalState = {};
		const quarantine: LogicalState = {};
		const tombstones: RowKey[] = [];
		for (const row of this.db
			.query<{ id: string; title: string; pinned: number }, []>(
				'SELECT * FROM notes ORDER BY id',
			)
			.all())
			rows[rowKey('notes', row.id)] = {
				deleted: false,
				cells: { title: row.title, pinned: Boolean(row.pinned) },
			};
		for (const row of this.db
			.query<{ id: string; name: string }, []>(
				'SELECT * FROM folders ORDER BY id',
			)
			.all())
			rows[rowKey('folders', row.id)] = {
				deleted: false,
				cells: { name: row.name },
			};
		for (const row of this.db
			.query<{ table_name: string; row_id: string; cells_json: string }, []>(
				'SELECT * FROM quarantine ORDER BY table_name,row_id',
			)
			.all())
			quarantine[rowKey(row.table_name, row.row_id)] = {
				deleted: false,
				cells: JSON.parse(row.cells_json),
			};
		for (const row of this.db
			.query<{ table_name: string; row_id: string }, []>(
				'SELECT * FROM tombstones ORDER BY table_name,row_id',
			)
			.all())
			tombstones.push(rowKey(row.table_name, row.row_id));
		return {
			actorId: this.actorId,
			nextActorSequence: Number(this.meta('next_actor_sequence')),
			pullCursor: Number(this.meta('pull_cursor')),
			outbox: this.outbox(),
			rows,
			quarantine,
			tombstones,
		};
	}
}
