/**
 * Canonical sync server (demo): authoritative record history per principal.
 *
 * One Bun process, one SQLite file per principal. The op log IS the
 * authority: conflict resolution for same-field writes is acceptance order.
 * The server understands the record schema (it materializes a queryable
 * `notes` view of the log) but treats Yjs doc frames as opaque bytes.
 *
 * Hosted vs self-host topology (ADR-0075 mirror), same client protocol:
 *   --mode hosted    bearer token names the principal (multi-principal)
 *   --mode selfhost  every bearer resolves to the literal 'instance'
 *
 * Run: bun server/main.ts [--mode hosted|selfhost] [--port 8788]
 */

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
	type AcceptedOp,
	type Op,
	PROTOCOL_VERSION,
	type PullResponse,
	type PushRequest,
	type PushResponse,
	SCHEMA_MAJOR,
} from '../shared/protocol';

const args = process.argv.slice(2);
function argValue(flag: string, fallback: string): string {
	const i = args.indexOf(flag);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const MODE = argValue('--mode', 'selfhost') as 'hosted' | 'selfhost';
const PORT = Number(argValue('--port', '8788'));
const DATA_DIR = join(import.meta.dir, 'data');
mkdirSync(DATA_DIR, { recursive: true });

// ─── Per-principal database ──────────────────────────────────────────────────

const databases = new Map<string, Database>();

function principalDb(principal: string): Database {
	let db = databases.get(principal);
	if (db) return db;
	db = new Database(join(DATA_DIR, `${principal}.sqlite`), { create: true });
	db.exec(`
		PRAGMA journal_mode=WAL;
		CREATE TABLE IF NOT EXISTS oplog (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			client_id TEXT NOT NULL,
			op_id TEXT NOT NULL UNIQUE,
			op TEXT NOT NULL
		);
		-- Server-side materialization: the server is schema-aware for records.
		CREATE TABLE IF NOT EXISTS notes (
			id TEXT PRIMARY KEY,
			cells TEXT NOT NULL DEFAULT '{}'
		);
	`);
	databases.set(principal, db);
	return db;
}

function materialize(db: Database, op: Op): void {
	if (op.kind === 'row-insert' && op.table === 'notes') {
		db.query(
			`INSERT INTO notes(id, cells) VALUES (?, ?)
			 ON CONFLICT(id) DO UPDATE SET cells = json_patch(cells, excluded.cells)`,
		).run(op.rowId, JSON.stringify(op.cells));
	} else if (op.kind === 'cell' && op.table === 'notes') {
		db.query(
			`INSERT INTO notes(id, cells) VALUES (?, json_object(?, json(?)))
			 ON CONFLICT(id) DO UPDATE SET cells = json_set(cells, '$.' || ?, json(?))`,
		).run(
			op.rowId,
			op.field,
			JSON.stringify(op.value),
			op.field,
			JSON.stringify(op.value),
		);
	} else if (op.kind === 'row-delete' && op.table === 'notes') {
		db.query('DELETE FROM notes WHERE id = ?').run(op.rowId);
	}
	// 'doc' ops are opaque: history only, no materialization.
}

// ─── Principal resolution (the ONLY thing that differs by mode) ─────────────

function resolvePrincipal(request: Request): string | null {
	const header = request.headers.get('authorization');
	const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
	if (!bearer) return null;
	if (MODE === 'selfhost') return 'instance';
	return /^[a-z0-9-]{1,64}$/.test(bearer) ? bearer : null;
}

// WebSocket auth rides a query param in the demo (browsers can't set WS headers).
function resolveWsPrincipal(url: URL): string | null {
	const bearer = url.searchParams.get('token');
	if (!bearer) return null;
	if (MODE === 'selfhost') return 'instance';
	return /^[a-z0-9-]{1,64}$/.test(bearer) ? bearer : null;
}

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, content-type',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...CORS },
	});
}

const server = Bun.serve<{ principal: string }>({
	port: PORT,
	async fetch(request, srv) {
		const url = new URL(request.url);
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: CORS });
		}

		if (url.pathname === '/sync/ws') {
			const principal = resolveWsPrincipal(url);
			if (!principal) return json({ error: 'unauthorized' }, 401);
			const upgraded = srv.upgrade(request, { data: { principal } });
			return upgraded
				? undefined
				: json({ error: 'upgrade failed' }, 400);
		}

		const principal = resolvePrincipal(request);
		if (!principal) return json({ error: 'unauthorized' }, 401);
		const db = principalDb(principal);

		if (url.pathname === '/sync/push' && request.method === 'POST') {
			const body = (await request.json()) as PushRequest;
			if (body.protocolVersion !== PROTOCOL_VERSION) {
				return json({ error: 'protocol-mismatch' }, 400);
			}
			if (body.schemaMajor !== SCHEMA_MAJOR) {
				const response: PushResponse = {
					ok: false,
					reason: 'schema-mismatch',
					serverSchemaMajor: SCHEMA_MAJOR,
				};
				return json(response, 409);
			}
			const insert = db.query(
				'INSERT OR IGNORE INTO oplog(client_id, op_id, op) VALUES (?,?,?)',
			);
			const tx = db.transaction((ops: Op[]) => {
				for (const op of ops) {
					const result = insert.run(body.clientId, op.opId, JSON.stringify(op));
					// Idempotent retry: an op already accepted is not re-materialized.
					if (result.changes > 0) materialize(db, op);
				}
			});
			tx(body.ops);
			const row = db
				.query('SELECT COALESCE(MAX(seq),0) AS seq FROM oplog')
				.get() as { seq: number };
			// Poke every connected client of this principal; they pull.
			srv.publish(principal, JSON.stringify({ type: 'poke', seq: row.seq }));
			const response: PushResponse = { ok: true, serverSeq: row.seq };
			return json(response);
		}

		if (url.pathname === '/sync/pull' && request.method === 'GET') {
			const schemaMajor = Number(url.searchParams.get('schemaMajor') ?? '0');
			if (schemaMajor !== SCHEMA_MAJOR) {
				const response: PullResponse = {
					ok: false,
					reason: 'schema-mismatch',
					serverSchemaMajor: SCHEMA_MAJOR,
				};
				return json(response, 409);
			}
			const cursor = Number(url.searchParams.get('cursor') ?? '0');
			const rows = db
				.query(
					'SELECT seq, client_id, op FROM oplog WHERE seq > ? ORDER BY seq LIMIT 2000',
				)
				.all(cursor) as { seq: number; client_id: string; op: string }[];
			const ops: AcceptedOp[] = rows.map((row) => ({
				...(JSON.parse(row.op) as Op),
				seq: row.seq,
				clientId: row.client_id,
			}));
			const response: PullResponse = {
				ok: true,
				ops,
				cursor: rows.length > 0 ? rows[rows.length - 1].seq : cursor,
			};
			return json(response);
		}

		// Debug surface: the server's own materialized view (proves authority).
		if (url.pathname === '/debug/notes' && request.method === 'GET') {
			const rows = db.query('SELECT id, cells FROM notes').all() as {
				id: string;
				cells: string;
			}[];
			return json(
				rows.map((row) => ({ id: row.id, ...JSON.parse(row.cells) })),
			);
		}

		return json({ error: 'not found' }, 404);
	},
	websocket: {
		open(ws) {
			ws.subscribe(ws.data.principal);
		},
		message() {
			// Clients never send over WS in this protocol; pokes flow one way.
		},
		close(ws) {
			ws.unsubscribe(ws.data.principal);
		},
	},
});

console.log(
	`[sync-server] mode=${MODE} port=${server.port} schemaMajor=${SCHEMA_MAJOR} data=${DATA_DIR}`,
);
