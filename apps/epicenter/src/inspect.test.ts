/**
 * The raw view's data surface, against a real replica.
 *
 * The claims under test are ADR-0209's: picking a namespace gets you real
 * tables, picking nothing gets you the honest storage shape, and nothing here
 * can write.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { epicenterPath, openBunEpicenter } from '@epicenter/data/bun';
import { field } from '@epicenter/field';
import { defineLens, defineTable, optional } from '@epicenter/lens';

import {
	type InspectSource,
	listInspectNamespaces,
	runInspectQuery,
} from './inspect.ts';

const notesLens = defineLens({
	namespace: 'so.epicenter.tests',
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

/** A second Lens that also declares `notes`, which is why grouping is the mode. */
const otherLens = defineLens({
	namespace: 'so.epicenter.other',
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
	},
});

let root: string;
let source: InspectSource;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'inspect-'));
	source = {
		replicaPath: epicenterPath({ directory: join(root, 'data') }),
		lenses: [notesLens as never, otherLens as never],
	};
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

async function seed() {
	await using epicenter = await openBunEpicenter({
		directory: join(root, 'data'),
	});
	const notes = epicenter.bind(notesLens).notes;
	const kept = await notes.create({
		title: 'Tuesday standup',
		tags: ['work'],
		content: 'Ship Friday.\n',
	});
	const removed = await notes.create({ title: 'Deleted', tags: [] });
	await notes.delete(removed.id);
	await epicenter.bind(otherLens).notes.create({ title: 'A different notes' });
	return kept.id;
}

test('the sidebar lists every namespace with its tables and columns', () => {
	expect(listInspectNamespaces(source.lenses)).toEqual([
		{
			namespace: 'so.epicenter.other',
			tables: [{ name: 'notes', fields: ['title'] }],
		},
		{
			namespace: 'so.epicenter.tests',
			tables: [{ name: 'notes', fields: ['title', 'tags', 'content'] }],
		},
	]);
});

test('picking a namespace makes SELECT * FROM notes work verbatim', async () => {
	const kept = await seed();

	const { data, error } = runInspectQuery({
		source,
		namespace: 'so.epicenter.tests',
		sql: 'SELECT * FROM notes',
	});

	expect(error).toBeNull();
	// Present rows only: a tombstone is not a note.
	expect(data?.rows).toEqual([
		{
			id: kept,
			title: 'Tuesday standup',
			tags: '["work"]',
			content: 'Ship Friday.\n',
		},
	]);
});

test('two namespaces can both declare notes, and each answers for itself', async () => {
	await seed();

	const mine = runInspectQuery({
		source,
		namespace: 'so.epicenter.tests',
		sql: 'SELECT title FROM notes',
	});
	const theirs = runInspectQuery({
		source,
		namespace: 'so.epicenter.other',
		sql: 'SELECT title FROM notes',
	});

	expect(mine.data?.rows).toEqual([{ title: 'Tuesday standup' }]);
	expect(theirs.data?.rows).toEqual([{ title: 'A different notes' }]);
});

test('picking nothing gets the honest storage shape, tombstones included', async () => {
	await seed();

	const { data, error } = runInspectQuery({
		source,
		sql: `SELECT namespace, table_name, presence FROM _epicenter_rows
		      ORDER BY namespace, presence`,
	});

	expect(error).toBeNull();
	// Everything raw is the only thing that spans applications, and it shows
	// absence as the real state it is.
	expect(data?.rows).toEqual([
		{
			namespace: 'so.epicenter.other',
			table_name: 'notes',
			presence: 'present',
		},
		{
			namespace: 'so.epicenter.tests',
			table_name: 'notes',
			presence: 'absent',
		},
		{
			namespace: 'so.epicenter.tests',
			table_name: 'notes',
			presence: 'present',
		},
	]);
});

test('the friendly tables do not exist until a namespace is picked', async () => {
	await seed();

	const { error } = runInspectQuery({ source, sql: 'SELECT * FROM notes' });

	// Not a fallback to raw: `notes` is ambiguous across two Lenses, so it has
	// no meaning until one interpretation is selected (ADR-0209).
	expect(error).not.toBeNull();
});

test('a namespace no Lens declares is refused rather than silently falling back', async () => {
	await seed();

	const { data, error } = runInspectQuery({
		source,
		namespace: 'so.epicenter.nope',
		sql: 'SELECT * FROM notes',
	});

	expect(data).toBeNull();
	expect(error?.message).toContain('so.epicenter.nope');
});

test('a submitted write fails in the engine', async () => {
	await seed();

	const { error } = runInspectQuery({
		source,
		sql: "UPDATE _replica_row_facts SET presence = 'absent'",
	});

	// The connection is opened read-only, so this is SQLite refusing rather than
	// a check here that someone could forget to write.
	expect(error).not.toBeNull();
});
