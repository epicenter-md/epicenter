/**
 * Schema-Opaque Canonical Records Tests
 *
 * Verifies the private JSON record map, release-local typed access, bounded
 * scans, repair-friendly patches, and disposable connection-local SQL views.
 *
 * Key behaviors:
 * - canonical payloads preserve unknown and nonconforming data
 * - patches validate only supplied fields and can repair invalid rows
 * - SQL access is read-only and projects fields with JSON base-type guards
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import type { RecordSyncSqlite } from '@epicenter/record-sync';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createCanonicalRecords } from './canonical-records.js';
import { defineTable } from './lens-definition.js';

const skillsDefinition = defineTable({
	fields: {
		title: field.string(),
		category: field.select(['general', 'writing']),
		rating: field.number({ minimum: 1, maximum: 5 }),
	},
	optional: ['category', 'rating'],
});

function createSqlite(database: Database): RecordSyncSqlite {
	return {
		run(sql, parameters = []) {
			database.run(sql, parameters as SQLQueryBindings[]);
		},
		all<TRow extends Record<string, string | number | null>>(
			sql: string,
			parameters: readonly (string | number | null)[] = [],
		): TRow[] {
			return database
				.query<TRow, SQLQueryBindings[]>(sql)
				.all(...(parameters as SQLQueryBindings[]));
		},
		transaction<TResult>(run: () => TResult): TResult {
			return database.transaction(run).immediate();
		},
	};
}

function setup() {
	const database = new Database(':memory:');
	const records = createCanonicalRecords(createSqlite(database), {
		skills: skillsDefinition,
	});
	return { database, records, skills: records.tables.skills };
}

function seed(
	database: Database,
	id: string,
	payload: Record<string, unknown>,
): void {
	database
		.query(
			`INSERT INTO __epicenter_records (table_key, row_id, payload) VALUES ('skills', ?, ?)`,
		)
		.run(id, JSON.stringify(payload));
}

test('create allocates structural ids and stores only canonical JSON', () => {
	const { database, skills } = setup();
	const created = skills.create({ title: 'Concise', rating: 4 });

	expect(created.id).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	expect(expectOk(skills.get(created.id))).toEqual(created);
	expect(
		database
			.query(
				`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`,
			)
			.all(),
	).toEqual([{ name: '__epicenter_records' }]);
	expect(() => skills.create({} as never)).toThrow(
		"Missing required field 'title'",
	);
	expect(() => skills.create({ title: 42 } as never)).toThrow(
		"Invalid field 'title'",
	);
});

test('get returns cloned raw JSON and issues for a nonconforming row', () => {
	const { database, skills } = setup();
	seed(database, 'broken', {
		title: 42,
		future: { ownedBy: 'another release' },
	});

	const error = expectErr(skills.get('broken'));
	expect(error).toMatchObject({
		name: 'NonconformingRecord',
		table: 'skills',
		id: 'broken',
		issues: [
			{
				field: 'title',
				kind: 'invalid',
				message: "Field 'title' is invalid",
			},
		],
	});
	error.raw.future = 'mutated error copy';
	const reread = expectErr(skills.get('broken'));
	expect(reread.raw.future).toEqual({ ownedBy: 'another release' });
});

test('a newly required field changes interpretation without rewriting storage', () => {
	const { database, skills } = setup();
	const stored = skills.create({ title: 'Old shape' });
	const stricterDefinition = defineTable({
		fields: {
			title: field.string(),
			category: field.select(['general', 'writing']),
		},
	});
	const stricter = createCanonicalRecords(createSqlite(database), {
		skills: stricterDefinition,
	}).tables.skills;

	const error = expectErr(stricter.get(stored.id));
	expect(error.issues).toEqual([
		{
			field: 'category',
			kind: 'missing',
			message: "Missing required field 'category'",
		},
	]);
	expect(expectOk(stricter.patch(stored.id, { category: 'general' }))).toEqual({
		id: stored.id,
		title: 'Old shape',
		category: 'general',
	});
});

test('patch repairs invalid rows and preserves unknown future keys', () => {
	const { database, skills } = setup();
	seed(database, 'repair-me', {
		title: 42,
		category: 'general',
		future: ['preserve', 'me'],
	});

	const repaired = expectOk(skills.patch('repair-me', { title: 'Repaired' }));
	expect(repaired).toEqual({
		id: 'repair-me',
		title: 'Repaired',
		category: 'general',
	});
	const stored = database
		.query(`SELECT payload FROM __epicenter_records WHERE row_id = ?`)
		.get('repair-me') as { payload: string };
	expect(JSON.parse(stored.payload)).toEqual({
		title: 'Repaired',
		category: 'general',
		future: ['preserve', 'me'],
	});

	expectOk(skills.patch('repair-me', { category: undefined }));
	expect(expectOk(skills.get('repair-me'))).toEqual({
		id: 'repair-me',
		title: 'Repaired',
	});
	expect(() =>
		skills.patch('repair-me', { title: undefined } as never),
	).toThrow("Required field 'title' cannot be unset");
	expect(() => skills.patch('repair-me', { future: true } as never)).toThrow(
		"Unknown field 'future'",
	);
	expect(
		expectOk(skills.patch('missing', { title: 'No upsert' })),
	).toBeUndefined();
	expect(() => skills.patch('missing', { future: true } as never)).toThrow(
		"Unknown field 'future'",
	);
});

test('scan is bounded and partitions conforming from invalid rows', () => {
	const { database, skills } = setup();
	seed(database, 'a', { title: 'A' });
	seed(database, 'b', { title: 2 });
	seed(database, 'c', { title: 'C' });

	const first = skills.scan({ limit: 2 });
	expect(first.rows).toEqual([{ id: 'a', title: 'A' }]);
	expect(first.nonconforming.map(({ id }) => id)).toEqual(['b']);
	expect(first.nextCursor).toBe('b');
	const second = skills.scan({ cursor: first.nextCursor, limit: 2 });
	expect(second.rows).toEqual([{ id: 'c', title: 'C' }]);
	expect(second.nextCursor).toBeUndefined();
	expect(() => skills.scan({ limit: 0 })).toThrow(/1 through 1000/);
	expect(() => skills.scan({ limit: 1_001 })).toThrow(/1 through 1000/);
});

test('SQL views guard base types without hiding refinement-invalid values', () => {
	const { database, records } = setup();
	seed(database, 'valid', { title: 'Valid', rating: 4 });
	seed(database, 'wrong-base', { title: 42, rating: 'high' });
	seed(database, 'wrong-refinement', { title: 'Still visible', rating: 99 });

	const rows = records.sql(
		'SELECT id, title, rating FROM skills ORDER BY id',
		[],
		Type.Object({
			id: Type.String(),
			title: Type.Union([Type.String(), Type.Null()]),
			rating: Type.Union([Type.Number(), Type.Null()]),
		}),
	);
	expect(rows).toEqual([
		{ id: 'valid', title: 'Valid', rating: 4 },
		{ id: 'wrong-base', title: null, rating: null },
		{ id: 'wrong-refinement', title: 'Still visible', rating: 99 },
	]);
	expect(
		database
			.query(
				`SELECT name FROM sqlite_temp_schema WHERE type = 'view' ORDER BY name`,
			)
			.all(),
	).toEqual([{ name: 'skills' }]);
	expect(() => records.sql('DELETE FROM skills', [], Type.Object({}))).toThrow(
		'sql() accepts only SELECT statements',
	);
	expect(() => records.sql('SELECT 1; SELECT 2', [], Type.Object({}))).toThrow(
		'sql() accepts exactly one statement',
	);
	for (const query of [
		'SELECT payload FROM __epicenter_records',
		'SELECT payload FROM "__epicenter_records"',
		'SELECT name FROM sqlite_schema',
		'SELECT * FROM pragma_table_list',
	]) {
		expect(() => records.sql(query, [], Type.Object({}))).toThrow(
			'sql() cannot access runtime-private storage',
		);
	}
	expect(() =>
		records.sql(
			'SELECT title FROM skills ORDER BY id',
			[],
			Type.Object({ title: Type.Number() }),
		),
	).toThrow(/does not satisfy the result schema/);

	expect(database.query('PRAGMA query_only').get()).toEqual({ query_only: 0 });
});

test('delete removes only the addressed canonical row', () => {
	const { skills } = setup();
	const first = skills.create({ title: 'First' });
	const second = skills.create({ title: 'Second' });

	skills.delete(first.id);
	expect(expectOk(skills.get(first.id))).toBeUndefined();
	expect(expectOk(skills.get(second.id))).toEqual(second);
	skills.delete(first.id);
});

test('construction refuses table names that cannot coexist as SQLite views', () => {
	const database = new Database(':memory:');
	const sqlite = createSqlite(database);
	expect(() =>
		createCanonicalRecords(sqlite, {
			skills: skillsDefinition,
			Skills: skillsDefinition,
		}),
	).toThrow(/collides with another table in SQLite/);
	expect(() =>
		createCanonicalRecords(sqlite, {
			sqlite_schema: skillsDefinition,
		}),
	).toThrow(/Invalid table name/);
});
