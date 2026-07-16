/**
 * Engine C worker: official SQLite WASM + OPFS (opfs-sahpool VFS).
 * Owns the database; the page talks to it via postMessage RPC.
 *
 * Honest sync-metadata cost is included: every write also maintains a
 * per-cell clock table (rowid, field, version, writer), the minimum a
 * column-level server-authoritative protocol needs.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
	churnPlan,
	FIELD_KEYS,
	makeNote,
	type NoteRow,
	noteId,
	remotePlan,
} from './shape';

type Sqlite3Stmt = {
	bind(values: unknown[]): Sqlite3Stmt;
	step(): boolean;
	reset(): Sqlite3Stmt;
	finalize(): void;
};

type Sqlite3Db = {
	exec(opts: {
		sql: string;
		bind?: unknown[];
		rowMode?: string;
		resultRows?: unknown[];
	}): unknown;
	exec(sql: string): unknown;
	prepare(sql: string): Sqlite3Stmt;
	close(): void;
};

const stmtCache = new Map<string, Sqlite3Stmt>();
function prepared(sql: string): Sqlite3Stmt {
	let stmt = stmtCache.get(sql);
	if (!stmt) {
		stmt = db!.prepare(sql);
		stmtCache.set(sql, stmt);
	}
	return stmt;
}
function run(sql: string, bind: unknown[]): void {
	const stmt = prepared(sql);
	stmt.bind(bind);
	stmt.step();
	stmt.reset();
}

let db: Sqlite3Db | null = null;
let poolUtil: { wipeFiles?: () => Promise<void> } & Record<string, unknown> =
	{};
let sqlite3: unknown = null;

const DB_FILE = '/bench-notes.db';

async function ensureInit() {
	if (sqlite3) return;
	sqlite3 = await (
		sqlite3InitModule as unknown as (opts?: {
			print?: (msg: string) => void;
			printErr?: (msg: string) => void;
		}) => Promise<unknown>
	)({
		print: () => {},
		printErr: (msg: string) => console.error('[sqlite]', msg),
	});
	poolUtil = await (
		sqlite3 as unknown as {
			installOpfsSAHPoolVfs: (opts: {
				name: string;
			}) => Promise<typeof poolUtil>;
		}
	).installOpfsSAHPoolVfs({ name: 'bench-pool' });
}

async function openDb() {
	await ensureInit();
	const PoolDb = (
		poolUtil as unknown as { OpfsSAHPoolDb: new (path: string) => Sqlite3Db }
	).OpfsSAHPoolDb;
	db = new PoolDb(DB_FILE);
	db.exec(`
		PRAGMA cache_size=-8000;
		CREATE TABLE IF NOT EXISTS notes (
			id TEXT PRIMARY KEY,
			folderId TEXT,
			title TEXT NOT NULL,
			preview TEXT NOT NULL,
			pinned INTEGER NOT NULL,
			createdAt TEXT NOT NULL,
			updatedAt TEXT NOT NULL,
			deletedAt TEXT,
			wordCount INTEGER
		);
		CREATE INDEX IF NOT EXISTS notes_updated ON notes(updatedAt DESC);
		CREATE TABLE IF NOT EXISTS cell_clock (
			row_id TEXT NOT NULL,
			field TEXT NOT NULL,
			version INTEGER NOT NULL,
			writer TEXT NOT NULL,
			PRIMARY KEY (row_id, field)
		) WITHOUT ROWID;
	`);
}

function rowValues(row: NoteRow): unknown[] {
	return [
		row.id,
		row.folderId,
		row.title,
		row.preview,
		row.pinned ? 1 : 0,
		row.createdAt,
		row.updatedAt,
		row.deletedAt,
		row.wordCount,
	];
}

const CLOCK_SQL = `INSERT INTO cell_clock(row_id, field, version, writer) VALUES (?,?,1,?)
	ON CONFLICT(row_id, field) DO UPDATE SET version = version + 1, writer = excluded.writer`;

// The chosen protocol (server acceptance order) needs no per-cell clocks;
// engines that DO need them (client-side merge) pay this. Both are measured.
let clockEnabled = true;

function bumpClock(rowId: string, fields: readonly string[], writer: string) {
	if (!clockEnabled) return;
	for (const field of fields) run(CLOCK_SQL, [rowId, field, writer]);
}

const api = {
	async configure(opts: { clock: boolean }) {
		clockEnabled = opts.clock;
		return {};
	},
	async reset() {
		if (db) {
			for (const stmt of stmtCache.values()) stmt.finalize();
			stmtCache.clear();
			db.close();
			db = null;
		}
		await ensureInit();
		const wipe = (poolUtil as { wipeFiles?: () => Promise<void> }).wipeFiles;
		if (wipe) await wipe.call(poolUtil);
	},
	async seed(n: number) {
		await openDb();
		const t0 = performance.now();
		db!.exec('BEGIN');
		for (let i = 0; i < n; i++) {
			const row = makeNote(i, 0);
			run(
				'INSERT OR REPLACE INTO notes VALUES (?,?,?,?,?,?,?,?,?)',
				rowValues(row),
			);
			bumpClock(row.id, FIELD_KEYS, 'seed');
		}
		db!.exec('COMMIT');
		const t1 = performance.now();
		return { insertMs: t1 - t0, persistMs: 0 };
	},
	async hydrate() {
		const t0 = performance.now();
		await openDb();
		const rows: unknown[] = [];
		db!.exec({
			sql: 'SELECT COUNT(*) FROM notes',
			rowMode: 'array',
			resultRows: rows,
		});
		const rowCount = Number((rows[0] as unknown[])[0]);
		return { hydrateMs: performance.now() - t0, rowCount };
	},
	async query100() {
		const t0 = performance.now();
		const rows: unknown[] = [];
		db!.exec({
			sql: 'SELECT * FROM notes WHERE deletedAt IS NULL ORDER BY updatedAt DESC LIMIT 100',
			rowMode: 'object',
			resultRows: rows,
		});
		return { ms: performance.now() - t0, count: rows.length };
	},
	async search(needle: string) {
		const t0 = performance.now();
		const rows: unknown[] = [];
		db!.exec({
			sql: 'SELECT COUNT(*) FROM notes WHERE title LIKE ? OR preview LIKE ?',
			bind: [`%${needle}%`, `%${needle}%`],
			rowMode: 'array',
			resultRows: rows,
		});
		return {
			ms: performance.now() - t0,
			count: Number((rows[0] as unknown[])[0]),
		};
	},
	async editOne(index: number) {
		const id = noteId(index);
		const t0 = performance.now();
		db!.exec('BEGIN');
		run('UPDATE notes SET title = ? WHERE id = ?', [`edited ${index}`, id]);
		bumpClock(id, ['title'], 'local');
		db!.exec('COMMIT');
		return { ms: performance.now() - t0 };
	},
	async churn(opCount: number) {
		const counted: unknown[] = [];
		db!.exec({
			sql: 'SELECT COUNT(*) FROM notes',
			rowMode: 'array',
			resultRows: counted,
		});
		const rowCount = Number((counted[0] as unknown[])[0]);
		const plan = churnPlan(rowCount, opCount);
		const t0 = performance.now();
		db!.exec('BEGIN');
		for (const op of plan) {
			if (op.kind === 'delete') {
				run('DELETE FROM notes WHERE id = ?', [op.id]);
				run('DELETE FROM cell_clock WHERE row_id = ?', [op.id]);
			} else if (op.kind === 'reinsert') {
				const row = makeNote(op.index, op.revision);
				run(
					'INSERT OR REPLACE INTO notes VALUES (?,?,?,?,?,?,?,?,?)',
					rowValues(row),
				);
				bumpClock(row.id, FIELD_KEYS, 'local');
			} else {
				run(`UPDATE notes SET ${op.field} = ? WHERE id = ?`, [op.value, op.id]);
				bumpClock(op.id, [op.field], 'local');
			}
		}
		db!.exec('COMMIT');
		return { ms: performance.now() - t0 };
	},
	async remoteApply(editCount: number) {
		const counted: unknown[] = [];
		db!.exec({
			sql: 'SELECT COUNT(*) FROM notes',
			rowMode: 'array',
			resultRows: counted,
		});
		const rowCount = Number((counted[0] as unknown[])[0]);
		const plan = remotePlan(rowCount, editCount);
		const t0 = performance.now();
		db!.exec('BEGIN');
		for (const edit of plan) {
			// Server-authoritative apply: server version wins; bump local clock to match.
			run(`UPDATE notes SET ${edit.field} = ? WHERE id = ?`, [
				edit.value,
				edit.id,
			]);
			bumpClock(edit.id, [edit.field], 'server');
		}
		db!.exec('COMMIT');
		return { ms: performance.now() - t0 };
	},
	async memory() {
		const perf = self.performance as unknown as {
			memory?: { usedJSHeapSize: number };
		};
		const js = perf.memory?.usedJSHeapSize ?? 0;
		const capi = (sqlite3 as { capi?: { sqlite3_memory_used?: () => number } })
			?.capi;
		const sqliteBytes = capi?.sqlite3_memory_used?.() ?? 0;
		const wasmHeap =
			(
				sqlite3 as {
					wasm?: { heap8u?: () => Uint8Array };
				}
			)?.wasm?.heap8u?.()?.byteLength ?? 0;
		return {
			bytes: js + wasmHeap,
			source: `worker js ${(js / 1048576).toFixed(1)}MB + wasm linear ${(wasmHeap / 1048576).toFixed(1)}MB (sqlite_memory_used ${(sqliteBytes / 1048576).toFixed(1)}MB)`,
		};
	},
	async persistSize() {
		const rows: unknown[] = [];
		db!.exec({
			sql: `SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()`,
			rowMode: 'array',
			resultRows: rows,
		});
		return {
			bytes: Number((rows[0] as unknown[])[0]),
			detail: 'sqlite page_count * page_size',
		};
	},
};

self.onmessage = async (event: MessageEvent) => {
	const { id, method, args } = event.data as {
		id: number;
		method: keyof typeof api;
		args: unknown[];
	};
	try {
		const fn = api[method] as (...a: unknown[]) => Promise<unknown>;
		const result = await fn(...args);
		self.postMessage({ id, result });
	} catch (error) {
		self.postMessage({ id, error: String(error) });
	}
};

self.postMessage({ ready: true });
