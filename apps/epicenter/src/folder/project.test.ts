/**
 * The projection, against a real replica.
 *
 * The claim under test is ADR-0208's: an agent runs `sqlite3` against a path in
 * the folder and gets one real table per Lens table, current with the rows.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { epicenterPath, openBunEpicenter } from '@epicenter/data/bun';
import { field } from '@epicenter/field';
import { defineLens, defineTable, optional } from '@epicenter/lens';

import {
	openFolderProjections,
	projectionPathFor,
	startFolderProjector,
} from './project.ts';

const NAMESPACE = 'so.epicenter.tests';

const lens = defineLens({
	namespace: NAMESPACE,
	tables: {
		notes: defineTable({
			fields: {
				title: field.string(),
				tags: field.tags(),
				content: optional(field.string()),
			},
			body: 'content',
		}),
	},
});

let root: string;
let folder: string;
let dataDirectory: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'folder-project-'));
	folder = join(root, 'Epicenter');
	dataDirectory = join(root, 'data');
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Read the projection the way an agent would: a fresh connection on a path. */
function readProjection<T>(sql: string): T[] {
	const database = new Database(projectionPathFor(folder, NAMESPACE), {
		readonly: true,
	});
	try {
		return database.query<T, []>(sql).all();
	} finally {
		database.close();
	}
}

test('the projection is one real table per Lens table, named as the Lens names it', async () => {
	await using epicenter = await openBunEpicenter({ directory: dataDirectory });
	const notes = epicenter.bind(lens).notes;
	await notes.create({ title: 'Tuesday', tags: ['work'], content: 'Ship.\n' });

	const projections = openFolderProjections({
		root: folder,
		replicaPath: epicenterPath({ directory: dataDirectory }),
		lenses: [lens as never],
	});
	projections.close();

	// The folder holds it beside the markdown, named for the app.
	expect(existsSync(join(folder, NAMESPACE, 'tests.sqlite3'))).toBe(true);

	const kinds = readProjection<{ name: string; type: string }>(
		"SELECT name, type FROM sqlite_schema WHERE type = 'table'",
	);
	expect(kinds).toEqual([{ name: 'notes', type: 'table' }]);

	// One column per declared field, plus the row id.
	const rows = readProjection<Record<string, unknown>>('SELECT * FROM notes');
	expect(rows).toHaveLength(1);
	expect(Object.keys(rows[0] ?? {})).toEqual([
		'id',
		'title',
		'tags',
		'content',
	]);
	expect(rows[0]).toMatchObject({ title: 'Tuesday', content: 'Ship.\n' });
});

test('a committed row reaches the projection, and a deleted one leaves it', async () => {
	await using epicenter = await openBunEpicenter({ directory: dataDirectory });
	const notes = epicenter.bind(lens).notes;
	const listeners: ((addresses: readonly never[]) => void)[] = [];

	const stop = startFolderProjector({
		root: folder,
		replicaPath: epicenterPath({ directory: dataDirectory }),
		lenses: [lens as never],
		subscribe: (listener) => {
			listeners.push(listener as never);
			return () => undefined;
		},
	});

	const commit = (rowId: string) => {
		for (const listener of listeners) {
			listener([{ namespace: NAMESPACE, tableName: 'notes', rowId }] as never);
		}
	};

	const row = await notes.create({ title: 'Later', tags: [] });
	commit(row.id);
	expect(readProjection<{ title: string }>('SELECT title FROM notes')).toEqual([
		{ title: 'Later' },
	]);

	await notes.patch(row.id, { title: 'Sooner' });
	commit(row.id);
	// One row still, not two: the write replaces rather than accumulating.
	expect(readProjection<{ title: string }>('SELECT title FROM notes')).toEqual([
		{ title: 'Sooner' },
	]);

	await notes.delete(row.id);
	commit(row.id);
	// A tombstone is not a note. The extraction takes present rows only, so a
	// deleted row leaves rather than lingering.
	expect(readProjection('SELECT * FROM notes')).toEqual([]);

	stop();
});

test('a projection that cannot open reports and leaves the host running', () => {
	// The query surface is a convenience over rows the replica already holds.
	// Refusing to boot over it would cost the applications instead.
	const failures: unknown[] = [];
	const stop = startFolderProjector({
		root: folder,
		replicaPath: join(root, 'no-such-replica.sqlite3'),
		lenses: [lens as never],
		subscribe: () => () => undefined,
		onError: (cause) => failures.push(cause),
	});

	expect(failures).toHaveLength(1);
	expect(() => stop()).not.toThrow();
});

test('the projection refuses a write to the replica through it', async () => {
	await using epicenter = await openBunEpicenter({ directory: dataDirectory });
	await epicenter.bind(lens).notes.create({ title: 'Held', tags: [] });

	const replicaPath = epicenterPath({ directory: dataDirectory });
	const projections = openFolderProjections({
		root: folder,
		replicaPath,
		lenses: [lens as never],
	});
	try {
		// `mode=ro` is the engine refusing, not a convention we keep.
		const database = new Database(projectionPathFor(folder, NAMESPACE));
		try {
			database.run('ATTACH DATABASE ? AS ro', [
				`${Bun.pathToFileURL(replicaPath).href}?mode=ro`,
			]);
			expect(() =>
				database.run("UPDATE ro._replica_row_facts SET presence = 'absent'"),
			).toThrow();
		} finally {
			database.close();
		}
	} finally {
		projections.close();
	}
});

test('opening again rebuilds from the replica rather than trusting the file', async () => {
	await using epicenter = await openBunEpicenter({ directory: dataDirectory });
	const notes = epicenter.bind(lens).notes;
	await notes.create({ title: 'Real', tags: [] });
	const replicaPath = epicenterPath({ directory: dataDirectory });

	openFolderProjections({
		root: folder,
		replicaPath,
		lenses: [lens as never],
	}).close();

	// Someone writes to a file the design says is read-only.
	const tampered = new Database(projectionPathFor(folder, NAMESPACE));
	tampered.run("UPDATE notes SET title = 'Forged'");
	tampered.close();
	expect(readProjection<{ title: string }>('SELECT title FROM notes')).toEqual([
		{ title: 'Forged' },
	]);

	// The next launch discards it. That is what deterministically rebuildable
	// buys, and it is the only enforcement a plain file can have.
	openFolderProjections({
		root: folder,
		replicaPath,
		lenses: [lens as never],
	}).close();
	expect(readProjection<{ title: string }>('SELECT title FROM notes')).toEqual([
		{ title: 'Real' },
	]);
});
