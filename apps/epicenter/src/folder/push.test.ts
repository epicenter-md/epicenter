import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';
import { defineTable, optional, type RowAddress } from '@epicenter/lens';
import { type FolderWriter, pushFolder } from './push.js';
import { openReceiptStore, type ReceiptStore } from './receipts.js';
import { renderIntoFolder } from './render-into.js';
import { scanFolder } from './scan.js';

const NAMESPACE = 'so.epicenter.tests';
const ROW = 'a8fk2mq7x3nb5wd9pc1rt4vz';
const MINTED = 'zzzz3nb5wd9pc1rt4vza8fk2';

const notes = defineTable({
	fields: {
		title: field.string(),
		tags: field.tags(),
		reviewed: optional(field.boolean()),
		content: optional(field.string()),
	},
	body: 'content',
});

const lookup = (namespace: string, tableName: string) =>
	namespace === NAMESPACE && tableName === 'notes' ? notes : undefined;

let root: string;
let receipts: ReceiptStore;
let writer: FolderWriter & { calls: string[]; rows: Map<string, unknown> };

function fakeWriter() {
	const calls: string[] = [];
	const rows = new Map<string, unknown>();
	return {
		calls,
		rows,
		async create(namespace: string, tableName: string, fields: object) {
			calls.push(`create ${namespace}/${tableName}`);
			rows.set(MINTED, fields);
			return MINTED;
		},
		async patch(address: RowAddress, changes: object) {
			calls.push(`patch ${address.rowId} ${JSON.stringify(changes)}`);
			if (!rows.has(address.rowId)) return false;
			return true;
		},
		async remove(address: RowAddress) {
			calls.push(`delete ${address.rowId}`);
			return rows.delete(address.rowId);
		},
	};
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'folder-push-'));
	mkdirSync(join(root, NAMESPACE, 'notes'), { recursive: true });
	receipts = openReceiptStore(join(root, 'receipts.sqlite3'));
	writer = fakeWriter();
});

afterEach(() => {
	receipts.close();
	rmSync(root, { recursive: true, force: true });
});

/** Put a row in the folder the way the renderer would, and in the fake replica. */
function seed(fields: Record<string, unknown>, rowId = ROW) {
	writer.rows.set(rowId, fields);
	const outcome = renderIntoFolder({
		root,
		receipts,
		address: { namespace: NAMESPACE, tableName: 'notes', rowId },
		fields: fields as never,
		definition: notes,
	});
	if (outcome.kind !== 'written') throw new Error('seed failed');
	return outcome.path;
}

function write(path: string, text: string) {
	writeFileSync(join(root, path), text);
}

const push = () => pushFolder({ root, receipts, lookup, writer });
const scan = () => scanFolder({ root, receipts, lookup });

test('a folder nobody touched sends nothing', async () => {
	seed({ title: 'Tuesday', tags: ['work'] });

	const report = await push();
	expect(writer.calls).toEqual([]);
	expect(report.patched).toBe(0);
});

test('an edited field is sent, and the folder is clean afterwards', async () => {
	// The bug this guards: push must settle the receipt for what it sent. If it
	// does not, the field stays "pending" forever, status never goes quiet, and
	// the renderer keeps protecting an edit that already landed.
	const path = seed({ title: 'Tuesday', tags: ['work'] });
	write(path, `---\nid: ${ROW}\ntitle: Wednesday\ntags:\n  - work\n---\n`);

	const report = await push();
	expect(writer.calls).toEqual([`patch ${ROW} {"title":"Wednesday"}`]);
	expect(report.patched).toBe(1);

	// Nothing left to say.
	expect(scan()[0]).toMatchObject({
		plan: { kind: 'patch', set: {}, unset: [] },
	});
	const second = await push();
	expect(second.patched).toBe(0);
});

test('clearing an optional field unsets it rather than sending null', async () => {
	const path = seed({ title: 'T', tags: [], reviewed: true });
	write(path, `---\nid: ${ROW}\ntitle: T\ntags: []\n---\n`);

	await push();
	expect(writer.calls).toEqual([`patch ${ROW} {}`]);
	// `undefined` is dropped by JSON.stringify, so assert the shape directly.
	const report = await push();
	expect(report.patched).toBe(0);
});

test('a new file is created once, and never creates a second row', async () => {
	// The bug this guards: the minted id must be written back into the file. If
	// it is not, every push sees an id-less file again and mints another row.
	write(
		`${NAMESPACE}/notes/idea.md`,
		'---\ntitle: New\ntags: []\n---\nProse\n',
	);

	const first = await push();
	expect(first.created).toBe(1);
	expect(writer.calls).toEqual([`create ${NAMESPACE}/notes`]);

	const second = await push();
	expect(second.created).toBe(0);
	expect(writer.calls).toHaveLength(1);

	// The file keeps the name you gave it; only the id arrives.
	const [entry] = scan();
	expect(entry).toMatchObject({
		kind: 'claim',
		path: `${NAMESPACE}/notes/idea.md`,
		address: { rowId: MINTED },
		plan: { kind: 'patch', set: {}, unset: [] },
	});
});

test('a deleted file deletes the row once and then goes quiet', async () => {
	const path = seed({ title: 'Tuesday', tags: [] });
	rmSync(join(root, path));

	const first = await push();
	expect(first.deleted).toBe(1);
	expect(writer.calls).toEqual([`delete ${ROW}`]);

	const second = await push();
	expect(second.deleted).toBe(0);
	expect(writer.calls).toHaveLength(1);
});

test('a file with no receipt is skipped and reported, never sent', async () => {
	write(
		`${NAMESPACE}/notes/stray.md`,
		`---\nid: ${ROW}\ntitle: T\ntags: []\n---\n`,
	);

	const report = await push();
	expect(writer.calls).toEqual([]);
	expect(report.skipped).toContainEqual({
		path: `${NAMESPACE}/notes/stray.md`,
		reason: 'unbased',
	});
});

test('duplicate ids are skipped on every copy, not resolved by picking one', async () => {
	const path = seed({ title: 'Tuesday', tags: [] });
	write(
		`${NAMESPACE}/notes/backup.md`,
		`---\nid: ${ROW}\ntitle: Copied\ntags: []\n---\n`,
	);

	const report = await push();
	expect(writer.calls).toEqual([]);
	expect(report.skipped).toHaveLength(2);
	expect(report.skipped.every((entry) => entry.reason === 'duplicate')).toBe(
		true,
	);
	expect(existsSync(join(root, path))).toBe(true);
});

test('an unreadable file is skipped and the good file beside it still lands', async () => {
	const path = seed({ title: 'Tuesday', tags: ['work'] });
	write(path, `---\nid: ${ROW}\ntitle: Wednesday\ntags:\n  - work\n---\n`);
	write(`${NAMESPACE}/notes/broken.md`, '---\n: :\n---\n');

	const report = await push();
	expect(report.patched).toBe(1);
	expect(report.skipped).toContainEqual({
		path: `${NAMESPACE}/notes/broken.md`,
		reason: 'refused',
	});
});

test('a patch to a row that vanished is reported rather than thrown', async () => {
	const path = seed({ title: 'Tuesday', tags: ['work'] });
	write(path, `---\nid: ${ROW}\ntitle: Wednesday\ntags:\n  - work\n---\n`);
	writer.rows.delete(ROW);

	const report = await push();
	expect(report.patched).toBe(0);
	expect(report.skipped).toContainEqual({ path, reason: 'row-vanished' });
	// The receipt is untouched, so the edit is still there to retry or discard.
	expect(
		receipts.get({ namespace: NAMESPACE, tableName: 'notes', rowId: ROW }),
	).toBeDefined();
});

test('a file under a table no Lens declares is left completely alone', async () => {
	mkdirSync(join(root, NAMESPACE, 'ghosts'), { recursive: true });
	write(`${NAMESPACE}/ghosts/x.md`, '---\ntitle: T\n---\n');

	const report = await push();
	expect(writer.calls).toEqual([]);
	expect(report.skipped).toContainEqual({
		path: `${NAMESPACE}/ghosts/x.md`,
		reason: 'unknown-table',
	});
});
