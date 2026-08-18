/**
 * The projection follower, proven on the public surface alone.
 *
 * Every capability here reaches the store through `list`, `get`, and
 * `subscribe` plus the portable declaration: nothing package-internal. That is
 * the point of the suite. If these tests pass, any follower (FTS, Markdown,
 * embeddings) can be composed the same way.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { defineDatabase } from '@epicenter/database';
import type { SqliteDatabase, SqliteValue } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { openMemory } from '../store/bun.js';
import { type DataOf, syncEngineOf } from '../store/store.js';
import { createSqliteProjection, type SqliteProjection } from './index.js';

const workspace = defineDatabase({
	id: 'so.epicenter.projectionlab',
	kv: { theme: "'light'|'dark' = 'light'", fontSize: 'number = 14' },
	tables: {
		notes: { title: 'string', tags: 'string[]', date: 'string|null' },
	},
});

let db: DataOf<typeof workspace>;
let sql: SqliteProjection;
let handle: Database;

beforeEach(() => {
	db = openMemory(workspace);
	handle = new Database(':memory:');
	sql = createSqliteProjection({
		data: db,
		workspace,
		sqlite: createBunSqliteAdapter(handle),
	});
});

function note(
	fields: Partial<Parameters<typeof db.tables.notes.create>[0]> = {},
) {
	const { data, error } = db.tables.notes.create({
		title: 'Groceries',
		tags: ['food'],
		date: null,
		...fields,
	});
	if (error !== null) throw error;
	return data;
}

describe('query always agrees with the live document', () => {
	test('a committed local write is visible at the next read', () => {
		const made = note();
		const { data: rows, error } = sql.query`SELECT id, title FROM notes`;
		expect(error).toBeNull();
		expect(rows).toEqual([{ id: made.id, title: 'Groceries' }]);
	});

	test('a deleted row leaves the projection', () => {
		const made = note();
		expect(sql.query`SELECT id FROM notes`.data).toHaveLength(1);
		db.tables.notes.delete(made.id);
		expect(sql.query`SELECT id FROM notes`.data).toEqual([]);
	});

	test('a read inside a table subscriber is never stale, whoever subscribed first', () => {
		// The subscriber registers on a FRESH store, before the projection even
		// exists, which is the worst ordering a follower can have. The read is
		// still fresh: dirty-marking rides `onCommitted`, which the store's
		// flush delivers before any table notification, so reading inside a
		// table subscriber always repairs first.
		const fresh = openMemory(workspace);
		const seen: number[] = [];
		let lateSql: SqliteProjection | undefined;
		fresh.tables.notes.subscribe(() => {
			if (lateSql === undefined) {
				seen.push(-1);
				return;
			}
			seen.push(
				(lateSql.query`SELECT count(*) AS n FROM notes`.data?.[0]
					?.n as number) ?? -1,
			);
		});
		lateSql = createSqliteProjection({
			data: fresh,
			workspace,
			sqlite: createBunSqliteAdapter(new Database(':memory:')),
		});
		fresh.tables.notes.create({ title: 'one', tags: [], date: null });
		fresh.tables.notes.create({ title: 'two', tags: [], date: null });
		expect(seen).toEqual([1, 2]);
	});

	test('a remote update reaches query without any patching path', () => {
		const remote = openMemory(workspace);
		remote.tables.notes.create({ title: 'from afar', tags: [], date: null });
		const bytes = remote.store.encodeStateSince(db.store.stateVector());
		syncEngineOf(db.store).applyRemote(bytes);
		expect(sql.query`SELECT title FROM notes`.data).toEqual([
			{ title: 'from afar' },
		]);
	});

	test('an array field is queryable through json_each', () => {
		note({ tags: ['food', 'errands'] });
		const { data: rows } = sql.query`
			SELECT value FROM notes, json_each(notes.tags) ORDER BY value
		`;
		expect(rows).toEqual([{ value: 'errands' }, { value: 'food' }]);
	});
});

describe('kv projects as a one-row relation', () => {
	test('kv is readable before anything has written to it', () => {
		const { data: rows } = sql.query`SELECT theme, fontSize FROM kv`;
		expect(rows).toEqual([{ theme: 'light', fontSize: 14 }]);
	});

	test('a kv write is visible at the next read', () => {
		db.kv.update({ theme: 'dark' });
		expect(sql.query`SELECT theme FROM kv`.data).toEqual([{ theme: 'dark' }]);
	});
});

describe('failure stays at the read, and heals at the read', () => {
	test('a refused statement is an ordinary caller outcome', () => {
		const { data, error } = sql.query`SELECT nope FROM nowhere`;
		expect(data).toBeNull();
		expect(error?.name).toBe('QueryFailed');
	});

	test('a rebuild that fails refuses the query and retries next read', () => {
		const inner = createBunSqliteAdapter(handle);
		const gate = { failing: false };
		const failable: SqliteDatabase = {
			all: (sqlText, params) => {
				if (gate.failing) throw new Error('projection refused');
				return inner.all(sqlText, params as SqliteValue[]);
			},
			run: (sqlText, params) => {
				if (gate.failing) throw new Error('projection refused');
				inner.run(sqlText, params as SqliteValue[]);
			},
			transaction: (work) => {
				if (gate.failing) throw new Error('projection refused');
				return inner.transaction(work);
			},
		};
		const fragile = createSqliteProjection({
			data: db,
			workspace,
			sqlite: failable,
		});
		note({ title: 'first' });
		expect(fragile.query`SELECT title FROM notes`.data).toEqual([
			{ title: 'first' },
		]);

		gate.failing = true;
		note({ title: 'second' });
		// The cache physically still holds only 'first'. Serving it would be a
		// lie, so the query is refused while the rebuild cannot run.
		expect(fragile.query`SELECT title FROM notes`.error?.name).toBe(
			'QueryFailed',
		);

		gate.failing = false;
		expect(fragile.query`SELECT title FROM notes ORDER BY title`.data).toEqual([
			{ title: 'first' },
			{ title: 'second' },
		]);
	});
});

describe('a nonconforming row projects raw, so SQL can show what failed', () => {
	test('the raw stored value appears where the declaration failed', () => {
		// The public surface refuses nonconforming writes, so stage one the way
		// it really happens: a replica on an older declaration writes a shape
		// this declaration cannot read, and the bytes arrive through sync.
		const older = openMemory(
			defineDatabase({
				id: 'so.epicenter.projectionlab',
				tables: { notes: { title: 'string', tags: 'string' } },
			}),
		);
		older.tables.notes.create({ title: 'legacy', tags: 'not-a-list' });
		const bytes = older.store.encodeStateSince(db.store.stateVector());
		syncEngineOf(db.store).applyRemote(bytes);

		const rows = sql.query`SELECT title, tags FROM notes`.data;
		expect(rows).toEqual([{ title: 'legacy', tags: 'not-a-list' }]);
	});
});

describe('lifecycle', () => {
	test('a workspace that drops a table sweeps its relation at rebuild', () => {
		// A relation left behind by an older declaration is dropped, so query
		// never serves a table the runtime cannot see.
		handle.run('CREATE TABLE scratch (id TEXT PRIMARY KEY, body ANY)');
		note();
		expect(sql.query`SELECT id FROM notes`.data).toHaveLength(1);
		expect(
			sql.query`SELECT name FROM sqlite_master WHERE name = 'scratch'`.data,
		).toEqual([]);
	});

	test('dispose detaches; later commits no longer touch the projection', () => {
		note({ title: 'before' });
		expect(sql.query`SELECT title FROM notes`.data).toEqual([
			{ title: 'before' },
		]);
		sql[Symbol.dispose]();
		expect(() => sql.query`SELECT 1 AS one`).toThrow();
	});
});
