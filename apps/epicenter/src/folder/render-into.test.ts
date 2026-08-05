import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';
import { defineTable, optional } from '@epicenter/lens';
import { expectOk } from 'wellcrafted/testing';

import { parseRow } from './parse.js';
import { planPush } from './plan.js';
import { openReceiptStore, type ReceiptStore } from './receipts.js';
import { renderIntoFolder } from './render-into.js';

const NAMESPACE = 'so.epicenter.tests';
const ROW = 'a8fk2mq7x3nb5wd9pc1rt4vz';
const address = { namespace: NAMESPACE, tableName: 'notes', rowId: ROW };

const notes = defineTable({
	fields: {
		title: field.string(),
		tags: field.tags(),
		content: optional(field.string()),
	},
	body: 'content',
});

let root: string;
let receipts: ReceiptStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'folder-render-'));
	receipts = openReceiptStore(join(root, 'receipts.sqlite3'));
});

afterEach(() => {
	receipts.close();
	rmSync(root, { recursive: true, force: true });
});

function render(fields: Record<string, unknown>) {
	return renderIntoFolder({
		root,
		receipts,
		address,
		fields: fields as never,
		definition: notes,
	});
}

function fileAt(path: string) {
	return expectOk(parseRow(readFileSync(join(root, path), 'utf8'), notes))
		.fields;
}

test('a row with no file yet is written at its default path', () => {
	const outcome = render({ title: 'Tuesday', tags: ['work'] });

	expect(outcome).toMatchObject({
		kind: 'written',
		path: `${NAMESPACE}/notes/${ROW}.md`,
	});
	expect(fileAt(`${NAMESPACE}/notes/${ROW}.md`)).toEqual({
		title: 'Tuesday',
		tags: ['work'],
	});
});

test('a clean file takes every change the row made', () => {
	const { path } = render({ title: 'Tuesday', tags: ['work'] }) as {
		path: string;
	};
	render({ title: 'Wednesday', tags: ['work', 'urgent'] });

	expect(fileAt(path)).toEqual({
		title: 'Wednesday',
		tags: ['work', 'urgent'],
	});
});

test('an unpushed edit survives a change to a different field', () => {
	const { path } = render({ title: 'Tuesday', tags: ['work'] }) as {
		path: string;
	};
	writeFileSync(
		join(root, path),
		`---\nid: ${ROW}\ntitle: My own title\ntags:\n  - work\n---\n`,
	);

	// A peer changed tags. Title is yours and unpushed.
	render({ title: 'Tuesday', tags: ['work', 'urgent'] });

	expect(fileAt(path)).toEqual({
		title: 'My own title',
		tags: ['work', 'urgent'],
	});
});

test('a field you edited is still pushable after the renderer runs', () => {
	// The property that makes the receipt worth keeping: rendering over a file
	// must not quietly swallow the edit by recording it as the new base.
	const { path } = render({ title: 'Tuesday', tags: ['work'] }) as {
		path: string;
	};
	writeFileSync(
		join(root, path),
		`---\nid: ${ROW}\ntitle: My own title\ntags:\n  - work\n---\n`,
	);
	render({ title: 'Tuesday', tags: ['work', 'urgent'] });

	const claim = expectOk(
		parseRow(readFileSync(join(root, path), 'utf8'), notes),
	);
	expect(planPush({ claim, base: receipts.get(address)?.fields })).toEqual({
		kind: 'patch',
		set: { title: 'My own title' },
		unset: [],
	});
});

test('a peer editing the same field you did does not overwrite you', () => {
	const { path } = render({ title: 'Tuesday', tags: ['work'] }) as {
		path: string;
	};
	writeFileSync(
		join(root, path),
		`---\nid: ${ROW}\ntitle: Mine\ntags:\n  - work\n---\n`,
	);
	render({ title: 'Theirs', tags: ['work'] });

	// Your unpushed edit stays in the file; pushing it later wins by order, which
	// is how two devices already resolve.
	expect(fileAt(path).title).toBe('Mine');
});

test('your prose survives exactly like any other field', () => {
	const { path } = render({
		title: 'T',
		tags: [],
		content: 'Ship Friday.\n',
	}) as { path: string };
	writeFileSync(
		join(root, path),
		`---\nid: ${ROW}\ntitle: T\ntags: []\n---\nShip Monday.\n`,
	);
	render({ title: 'Renamed', tags: [], content: 'Ship Friday.\n' });

	expect(fileAt(path)).toEqual({
		title: 'Renamed',
		tags: [],
		content: 'Ship Monday.\n',
	});
});

test('a renamed file keeps being the row’s file', () => {
	render({ title: 'Tuesday', tags: [] });
	const renamed = `${NAMESPACE}/notes/weekly.md`;
	receipts.record({
		...(receipts.get(address) as NonNullable<ReturnType<typeof receipts.get>>),
		path: renamed,
	});
	writeFileSync(
		join(root, renamed),
		`---\nid: ${ROW}\ntitle: Tuesday\ntags: []\n---\n`,
	);

	const outcome = render({ title: 'Wednesday', tags: [] });
	expect(outcome).toMatchObject({ kind: 'written', path: renamed });
	expect(fileAt(renamed).title).toBe('Wednesday');
});

test('a deleted row takes its file and its receipt with it', () => {
	const { path } = render({ title: 'Tuesday', tags: [] }) as { path: string };

	const outcome = renderIntoFolder({
		root,
		receipts,
		address,
		fields: undefined,
		definition: notes,
	});

	expect(outcome).toEqual({ kind: 'removed', path });
	expect(existsSync(join(root, path))).toBe(false);
	expect(receipts.get(address)).toBeUndefined();
});
