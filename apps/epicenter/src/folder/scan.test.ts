import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';
import { defineTable, optional } from '@epicenter/lens';

import { openReceiptStore, type ReceiptStore } from './receipts.js';
import { renderRow } from './render.js';
import { scanFolder } from './scan.js';

const NAMESPACE = 'so.epicenter.tests';
const ROW = 'a8fk2mq7x3nb5wd9pc1rt4vz';
const OTHER = 'bq7x3nb5wd9pc1rt4vza8fk2';

const notes = defineTable({
	fields: {
		title: field.string(),
		tags: field.tags(),
		content: optional(field.string()),
	},
	body: 'content',
});

const lookup = (namespace: string, tableName: string) =>
	namespace === NAMESPACE && tableName === 'notes' ? notes : undefined;

let root: string;
let receipts: ReceiptStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'folder-scan-'));
	mkdirSync(join(root, NAMESPACE, 'notes'), { recursive: true });
	receipts = openReceiptStore(join(root, 'receipts.sqlite3'));
});

afterEach(() => {
	receipts.close();
	rmSync(root, { recursive: true, force: true });
});

/** Write a file the way the renderer would, and record its receipt. */
function render(name: string, fields: Record<string, unknown>, rowId = ROW) {
	const path = `${NAMESPACE}/notes/${name}.md`;
	writeFileSync(
		join(root, path),
		renderRow({ id: rowId, fields: fields as never, definition: notes }),
	);
	receipts.record({
		address: { namespace: NAMESPACE, tableName: 'notes', rowId },
		path,
		fields: fields as never,
	});
	return path;
}

function edit(path: string, text: string) {
	writeFileSync(join(root, path), text);
}

test('a folder nobody has touched asks for nothing', () => {
	render('tuesday', { title: 'Tuesday', tags: ['work'], content: 'Ship.\n' });

	const entries = scanFolder({ root, receipts, lookup });
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({
		kind: 'claim',
		plan: { kind: 'patch', set: {}, unset: [] },
	});
});

test('an edit made while nothing was watching is found exactly the same', () => {
	const path = render('tuesday', { title: 'Tuesday', tags: ['work'] });
	edit(path, `---\nid: ${ROW}\ntitle: Wednesday\ntags:\n  - work\n---\n`);

	const [entry] = scanFolder({ root, receipts, lookup });
	expect(entry).toMatchObject({
		kind: 'claim',
		address: { namespace: NAMESPACE, tableName: 'notes', rowId: ROW },
		plan: { kind: 'patch', set: { title: 'Wednesday' }, unset: [] },
	});
});

test('a file with no receipt is refused rather than pushed whole', () => {
	writeFileSync(
		join(root, NAMESPACE, 'notes', 'stray.md'),
		`---\nid: ${ROW}\ntitle: T\ntags: []\n---\n`,
	);

	const [entry] = scanFolder({ root, receipts, lookup });
	expect(entry).toMatchObject({ kind: 'claim', plan: { kind: 'unbased' } });
});

test('a file with no id asks for a row to be minted', () => {
	writeFileSync(
		join(root, NAMESPACE, 'notes', 'idea.md'),
		'---\ntitle: New\ntags: []\n---\nProse\n',
	);

	const [entry] = scanFolder({ root, receipts, lookup });
	expect(entry).toMatchObject({
		kind: 'new',
		namespace: NAMESPACE,
		tableName: 'notes',
		plan: { kind: 'create' },
	});
});

test('a receipt with no file is a pending deletion, always reported', () => {
	const path = render('tuesday', { title: 'Tuesday', tags: [] });
	rmSync(join(root, path));

	const [entry] = scanFolder({ root, receipts, lookup });
	expect(entry).toEqual({
		kind: 'gone',
		path,
		address: { namespace: NAMESPACE, tableName: 'notes', rowId: ROW },
	});
});

test('copying a file is refused by naming every path, never by guessing', () => {
	// `cp tuesday.md backup.md` duplicates the id in frontmatter.
	render('tuesday', { title: 'Tuesday', tags: [] });
	render('backup', { title: 'Tuesday', tags: [] });

	const entries = scanFolder({ root, receipts, lookup });
	expect(entries).toHaveLength(2);
	for (const entry of entries) {
		expect(entry.kind).toBe('duplicate');
		expect(entry).toHaveProperty('paths', [
			`${NAMESPACE}/notes/backup.md`,
			`${NAMESPACE}/notes/tuesday.md`,
		]);
	}
});

test('two files carrying different ids are not duplicates', () => {
	render('tuesday', { title: 'Tuesday', tags: [] }, ROW);
	render('friday', { title: 'Friday', tags: [] }, OTHER);

	const entries = scanFolder({ root, receipts, lookup });
	expect(entries.every((entry) => entry.kind === 'claim')).toBe(true);
});

test('an unreadable file is named and every other file still reports', () => {
	render('tuesday', { title: 'Tuesday', tags: [] });
	writeFileSync(join(root, NAMESPACE, 'notes', 'broken.md'), '---\n: :\n---\n');

	const entries = scanFolder({ root, receipts, lookup });
	expect(
		entries.find((entry) => entry.path.endsWith('broken.md')),
	).toMatchObject({ kind: 'refused' });
	// No transaction spans rows, so the good file is unaffected by the bad one.
	expect(entries.find((entry) => entry.path.endsWith('tuesday.md'))?.kind).toBe(
		'claim',
	);
});

test('a file under a table no Lens declares is reported, not acted on', () => {
	mkdirSync(join(root, NAMESPACE, 'ghosts'), { recursive: true });
	writeFileSync(
		join(root, NAMESPACE, 'ghosts', 'x.md'),
		'---\ntitle: T\n---\n',
	);

	const [entry] = scanFolder({ root, receipts, lookup });
	expect(entry).toEqual({
		kind: 'unknown-table',
		path: `${NAMESPACE}/ghosts/x.md`,
		namespace: NAMESPACE,
		tableName: 'ghosts',
	});
});

test('a receipt store that was lost heals into refusals, never into bad pushes', () => {
	const path = render('tuesday', { title: 'Tuesday', tags: ['work'] });
	edit(path, `---\nid: ${ROW}\ntitle: Wednesday\ntags: []\n---\n`);
	receipts.forget({ namespace: NAMESPACE, tableName: 'notes', rowId: ROW });

	const [entry] = scanFolder({ root, receipts, lookup });
	// Without a receipt every field looks changed, so pushing would send `tags`
	// too and revert whatever a peer did to it. Refusing is the only safe read.
	expect(entry).toMatchObject({ plan: { kind: 'unbased' } });
});

test('renaming a file carries its receipt with it', () => {
	// The id in frontmatter binds, so the filename is decoration. A rename must
	// not read as a deletion plus a stranger with no receipt (ADR-0207).
	const path = render('tuesday', { title: 'Tuesday', tags: ['work'] });
	renameSync(join(root, path), join(root, NAMESPACE, 'notes', 'weekly.md'));

	const entries = scanFolder({ root, receipts, lookup });
	expect(entries).toHaveLength(1);
	expect(entries[0]).toMatchObject({
		kind: 'claim',
		path: `${NAMESPACE}/notes/weekly.md`,
		address: { namespace: NAMESPACE, tableName: 'notes', rowId: ROW },
		plan: { kind: 'patch', set: {}, unset: [] },
	});
});
