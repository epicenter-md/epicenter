import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBunEpicenter } from '@epicenter/data/bun';
import { field } from '@epicenter/field';
import { defineLens, defineTable, optional } from '@epicenter/lens';

import { createFolderBridge, startFolderRenderer } from './bridge.js';
import { pushFolder } from './push.js';
import { openReceiptStore, type ReceiptStore } from './receipts.js';
import { scanFolder } from './scan.js';
import { formatStatus, statusOf } from './status.js';

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
let receipts: ReceiptStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'folder-live-'));
	folder = join(root, 'Epicenter');
	receipts = openReceiptStore(join(root, 'receipts.sqlite3'));
});

afterEach(() => {
	receipts.close();
	rmSync(root, { recursive: true, force: true });
});

/** Let the renderer's serialized queue drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a row written through the API appears in the folder and edits back', async () => {
	// The recognition test, end to end against a real replica.
	const epicenter = await openBunEpicenter({ directory: join(root, 'data') });
	try {
		const notes = epicenter.bind(lens).notes;
		const listeners: ((changes: readonly never[]) => void)[] = [];
		const bridge = createFolderBridge({
			source: {
				epicenter: epicenter as never,
				subscribeInvalidations: (listener) => {
					listeners.push(listener as never);
					return () => undefined;
				},
			},
			lenses: [lens as never],
		});
		startFolderRenderer({ root: folder, receipts, bridge });

		const row = await notes.create({
			title: 'Tuesday',
			tags: ['work'],
			content: 'Ship Friday.\n',
		});
		const address = {
			namespace: NAMESPACE,
			tableName: 'notes',
			rowId: row.id,
		};

		// Drive the subscription the way a commit would.
		for (const listener of listeners) listener([address] as never);
		await settle();

		const path = `${NAMESPACE}/notes/${row.id}.md`;
		const onDisk = readFileSync(join(folder, path), 'utf8');
		expect(onDisk).toContain(`id: ${row.id}`);
		expect(onDisk).toContain('title: Tuesday');
		expect(onDisk.endsWith('Ship Friday.\n')).toBe(true);

		// Nothing to say about a folder nobody has touched.
		const lookup = bridge.lookup;
		expect(statusOf(scanFolder({ root: folder, receipts, lookup })).quiet).toBe(
			true,
		);

		// Edit it the way vim or an agent would.
		writeFileSync(
			join(folder, path),
			`---\nid: ${row.id}\ntitle: Wednesday\ntags:\n  - work\n  - sync\n---\nShip Monday.\n`,
		);

		const status = statusOf(scanFolder({ root: folder, receipts, lookup }));
		expect(status.quiet).toBe(false);
		expect(status.lines).toEqual([
			{ path, label: 'modified', fields: ['content', 'tags', 'title'] },
		]);
		expect(formatStatus(status)).toContain('modified');

		const report = await pushFolder({
			root: folder,
			receipts,
			lookup,
			writer: bridge.writer,
		});
		expect(report).toMatchObject({ patched: 1, created: 0, deleted: 0 });

		// It landed in the replica, prose included.
		const after = (await notes.get(row.id)).data;
		expect(after).toMatchObject({
			title: 'Wednesday',
			tags: ['work', 'sync'],
			content: 'Ship Monday.\n',
		});

		// And the folder has nothing left to say.
		expect(statusOf(scanFolder({ root: folder, receipts, lookup })).quiet).toBe(
			true,
		);
	} finally {
		await epicenter[Symbol.asyncDispose]();
	}
});

test('a file you create in the folder becomes a row exactly once', async () => {
	const epicenter = await openBunEpicenter({ directory: join(root, 'data') });
	try {
		const notes = epicenter.bind(lens).notes;
		const bridge = createFolderBridge({
			source: {
				epicenter: epicenter as never,
				subscribeInvalidations: () => () => undefined,
			},
			lenses: [lens as never],
		});

		const path = `${NAMESPACE}/notes/idea.md`;
		mkdirSync(join(folder, NAMESPACE, 'notes'), { recursive: true });
		writeFileSync(
			join(folder, path),
			'---\ntitle: An idea\ntags: []\n---\nWrite it down.\n',
		);

		const first = await pushFolder({
			root: folder,
			receipts,
			lookup: bridge.lookup,
			writer: bridge.writer,
		});
		expect(first.created).toBe(1);

		const second = await pushFolder({
			root: folder,
			receipts,
			lookup: bridge.lookup,
			writer: bridge.writer,
		});
		expect(second.created).toBe(0);

		const scanned = scanFolder({
			root: folder,
			receipts,
			lookup: bridge.lookup,
		});
		expect(scanned).toHaveLength(1);
		const entry = scanned[0];
		if (entry?.kind !== 'claim') throw new Error('expected a claim');
		const created = (await notes.get(entry.address.rowId)).data;
		expect(created).toMatchObject({
			title: 'An idea',
			content: 'Write it down.\n',
		});
	} finally {
		await epicenter[Symbol.asyncDispose]();
	}
});
