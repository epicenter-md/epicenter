/**
 * Client database worker: the complete durable local database (SQLite/OPFS).
 *
 * Owns everything durable for one profile:
 *  - `notes`        materialized records (known fields as columns, unknown
 *                   fields preserved in an `extra` JSON column — an old
 *                   client carries newer fields without understanding them)
 *  - `outbox`       ops awaiting push (survives restarts; grows offline)
 *  - `doc_updates`  Yjs update frames per child doc (lazy bodies live here)
 *  - `sync_state`   pull cursor
 *
 * Every committed write (local or remote) posts a 'change' notification;
 * the page re-runs live queries off that signal — no polling anywhere.
 *
 * The worker is version-parameterized: a "v1" build knows fewer fields
 * (no `subtitle`), which is how the demo proves mixed-version safety.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { AcceptedOp, JsonCell, Op } from '../../shared/protocol';

type Sqlite3Stmt = {
	bind(values: unknown[]): Sqlite3Stmt;
	step(): boolean;
	get(target: unknown[]): unknown[];
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

const V2_FIELDS = ['title', 'pinned', 'updatedAt', 'subtitle'] as const;
const V1_FIELDS = ['title', 'pinned', 'updatedAt'] as const;

let db: Sqlite3Db | null = null;
let sqlite3: unknown = null;
let poolUtil: Record<string, unknown> = {};
let knownFields: readonly string[] = V2_FIELDS;
let clientId = 'unset';

const stmtCache = new Map<string, Sqlite3Stmt>();
function prepared(sql: string): Sqlite3Stmt {
	let stmt = stmtCache.get(sql);
	if (!stmt) {
		stmt = db!.prepare(sql);
		stmtCache.set(sql, stmt);
	}
	return stmt;
}
function run(sql: string, bind: unknown[] = []): void {
	const stmt = prepared(sql);
	if (bind.length > 0) stmt.bind(bind);
	stmt.step();
	stmt.reset();
}
function all<T>(sql: string, bind: unknown[] = []): T[] {
	const rows: unknown[] = [];
	db!.exec({ sql, bind, rowMode: 'object', resultRows: rows });
	return rows as T[];
}

function notifyChange(scope: string) {
	self.postMessage({ type: 'change', scope });
}

async function ensureInit() {
	if (sqlite3) return;
	sqlite3 = await (
		sqlite3InitModule as unknown as (opts?: object) => Promise<unknown>
	)({ print: () => {}, printErr: (m: string) => console.error('[sqlite]', m) });
	poolUtil = await (
		sqlite3 as {
			installOpfsSAHPoolVfs: (o: { name: string }) => Promise<typeof poolUtil>;
		}
	).installOpfsSAHPoolVfs({ name: 'demo-pool' });
}

function columnDdl(): string {
	return knownFields
		.map((field) => (field === 'pinned' ? `${field} INTEGER` : `${field} TEXT`))
		.join(', ');
}

async function openFile(file: string) {
	await ensureInit();
	if (db) {
		for (const stmt of stmtCache.values()) stmt.finalize();
		stmtCache.clear();
		db.close();
		db = null;
	}
	const PoolDb = (
		poolUtil as { OpfsSAHPoolDb: new (path: string) => Sqlite3Db }
	).OpfsSAHPoolDb;
	db = new PoolDb(`/${file}`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS notes (
			id TEXT PRIMARY KEY,
			${columnDdl()},
			extra TEXT NOT NULL DEFAULT '{}'
		);
		CREATE TABLE IF NOT EXISTS outbox (
			idx INTEGER PRIMARY KEY AUTOINCREMENT,
			op TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS doc_updates (
			doc_id TEXT NOT NULL,
			idx INTEGER PRIMARY KEY AUTOINCREMENT,
			op_id TEXT NOT NULL UNIQUE,
			update_b64 TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS doc_updates_doc ON doc_updates(doc_id);
		CREATE TABLE IF NOT EXISTS sync_state (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);
	// Local, serverless schema migration: a newer build adds its columns.
	const existing = new Set(
		all<{ name: string }>('SELECT name FROM pragma_table_info(?)', [
			'notes',
		]).map((row) => row.name),
	);
	for (const field of knownFields) {
		if (!existing.has(field)) {
			run(
				`ALTER TABLE notes ADD COLUMN ${field} ${field === 'pinned' ? 'INTEGER' : 'TEXT'}`,
			);
		}
	}
}

/** Apply one op to the materialized notes table. Shared by local + remote. */
function applyOp(op: Op) {
	if (op.kind === 'row-insert' && op.table === 'notes') {
		run('INSERT OR IGNORE INTO notes(id) VALUES (?)', [op.rowId]);
		for (const [field, value] of Object.entries(op.cells)) {
			applyCell(op.rowId, field, value);
		}
	} else if (op.kind === 'cell' && op.table === 'notes') {
		run('INSERT OR IGNORE INTO notes(id) VALUES (?)', [op.rowId]);
		applyCell(op.rowId, op.field, op.value);
	} else if (op.kind === 'row-delete' && op.table === 'notes') {
		run('DELETE FROM notes WHERE id = ?', [op.rowId]);
	} else if (op.kind === 'doc') {
		run(
			'INSERT OR IGNORE INTO doc_updates(doc_id, op_id, update_b64) VALUES (?,?,?)',
			[op.docId, op.opId, op.update],
		);
	}
}

function applyCell(rowId: string, field: string, value: JsonCell) {
	if (knownFields.includes(field)) {
		run(`UPDATE notes SET ${field} = ? WHERE id = ?`, [
			typeof value === 'boolean' ? (value ? 1 : 0) : value,
			rowId,
		]);
	} else {
		// Unknown newer field: preserved verbatim, never erased, not understood.
		run(
			`UPDATE notes SET extra = json_set(extra, '$.' || ?, json(?)) WHERE id = ?`,
			[field, JSON.stringify(value), rowId],
		);
	}
}

let opCounter = 0;
function newOpId(): string {
	return `${clientId}-${Date.now()}-${opCounter++}`;
}

const api = {
	async open(opts: { file: string; appVersion: 1 | 2; clientId: string }) {
		knownFields = opts.appVersion === 1 ? V1_FIELDS : V2_FIELDS;
		clientId = opts.clientId;
		await openFile(opts.file);
		return { knownFields: [...knownFields] };
	},

	/** Local write: apply + enqueue, one transaction, then notify. */
	async write(op: Omit<Op, 'opId'>) {
		const full = { ...op, opId: newOpId() } as Op;
		db!.exec('BEGIN');
		applyOp(full);
		run('INSERT INTO outbox(op) VALUES (?)', [JSON.stringify(full)]);
		db!.exec('COMMIT');
		notifyChange(full.kind === 'doc' ? `doc:${full.docId}` : 'notes');
		return { opId: full.opId };
	},

	/**
	 * Remote ops from a pull: apply EVERY op in log order — including our own
	 * echoes — so the materialized state converges to the server's acceptance
	 * order. Cell re-application is idempotent; doc frames dedupe on op_id.
	 */
	async applyRemote(opts: { ops: AcceptedOp[]; cursor: number }) {
		let applied = 0;
		const docsTouched = new Set<string>();
		db!.exec('BEGIN');
		for (const op of opts.ops) {
			applyOp(op);
			applied++;
			if (op.kind === 'doc' && op.clientId !== clientId)
				docsTouched.add(op.docId);
		}
		run(
			`INSERT INTO sync_state(key, value) VALUES ('cursor', ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			[String(opts.cursor)],
		);
		db!.exec('COMMIT');
		if (applied > 0) {
			notifyChange('notes');
			for (const docId of docsTouched) notifyChange(`doc:${docId}`);
		}
		return { applied };
	},

	async outbox(): Promise<{ idx: number; op: Op }[]> {
		return all<{ idx: number; op: string }>(
			'SELECT idx, op FROM outbox ORDER BY idx',
		).map((row) => ({ idx: row.idx, op: JSON.parse(row.op) as Op }));
	},

	async clearOutbox(opts: { upTo: number }) {
		run('DELETE FROM outbox WHERE idx <= ?', [opts.upTo]);
		return {};
	},

	async cursor(): Promise<{ cursor: number }> {
		const rows = all<{ value: string }>(
			`SELECT value FROM sync_state WHERE key = 'cursor'`,
		);
		return { cursor: rows.length > 0 ? Number(rows[0].value) : 0 };
	},

	async listNotes() {
		return all<Record<string, unknown>>(
			`SELECT * FROM notes ORDER BY updatedAt DESC`,
		);
	},

	async getNote(opts: { id: string }) {
		const rows = all<Record<string, unknown>>(
			'SELECT * FROM notes WHERE id = ?',
			[opts.id],
		);
		return rows[0] ?? null;
	},

	/** Lazy body load: only called when a note body is opened. */
	async docUpdates(opts: { docId: string }) {
		return all<{ update_b64: string }>(
			'SELECT update_b64 FROM doc_updates WHERE doc_id = ? ORDER BY idx',
			[opts.docId],
		).map((row) => row.update_b64);
	},

	async counts() {
		const notes = all<{ n: number }>('SELECT COUNT(*) AS n FROM notes')[0].n;
		const outbox = all<{ n: number }>('SELECT COUNT(*) AS n FROM outbox')[0].n;
		return { notes, outbox };
	},

	/** Sign-in migration source read: full typed rows for the import plan. */
	async exportRows() {
		return all<Record<string, unknown>>('SELECT * FROM notes');
	},

	async wipe(opts: { file: string }) {
		if (db) {
			for (const stmt of stmtCache.values()) stmt.finalize();
			stmtCache.clear();
			db.close();
			db = null;
		}
		await ensureInit();
		const unlink = (poolUtil as { unlink?: (path: string) => boolean }).unlink;
		unlink?.call(poolUtil, `/${opts.file}`);
		return {};
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

self.postMessage({ type: 'ready' });
