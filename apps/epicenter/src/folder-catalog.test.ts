/**
 * The folder's two verbs, driven the way the host drives them.
 *
 * `folder-live.test.ts` proves the round trip through the functions. This proves
 * it through the tool boundary, which is the surface a chat turn and a direct
 * invocation actually reach (ADR-0021).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentToolOutcome, ToolCatalog } from '@epicenter/agent';
import { openBunEpicenter } from '@epicenter/data/bun';
import { field } from '@epicenter/field';
import { defineLens, defineTable, optional } from '@epicenter/lens';
import { createFolderBridge, startFolderRenderer } from './folder/bridge.ts';
import { openReceiptStore, type ReceiptStore } from './folder/receipts.ts';
import { createFolderCatalog } from './folder-catalog.ts';

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
	root = mkdtempSync(join(tmpdir(), 'folder-catalog-'));
	folder = join(root, 'Epicenter');
	receipts = openReceiptStore(join(root, 'receipts.sqlite3'));
});

afterEach(() => {
	receipts.close();
	rmSync(root, { recursive: true, force: true });
});

function invoke(catalog: ToolCatalog, toolName: string) {
	return catalog.resolve(
		{ toolCallId: 'call-1', toolName, input: {} },
		new AbortController().signal,
	);
}

test('status on a folder nothing has rendered into yet is quiet', async () => {
	// The fresh-install case: the directory does not exist, and the honest answer
	// is that there is nothing to push rather than a filesystem error.
	const catalog = createFolderCatalog({
		root: folder,
		receipts,
		lookup: () => lens.tables.notes,
		writer: {
			create: async () => 'unused',
			patch: async () => false,
			remove: async () => false,
		},
	});

	const outcome = await invoke(catalog, 'status');
	expect(outcome.isError).toBe(false);
	expect(outcome.content).toBe('Nothing to push.');
});

test('an edit made in the folder reaches the replica through push', async () => {
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
		const catalog = createFolderCatalog({
			root: folder,
			receipts,
			lookup: bridge.lookup,
			writer: bridge.writer,
		});

		const row = await notes.create({
			title: 'Tuesday',
			tags: ['work'],
			content: 'Ship Friday.\n',
		});
		for (const listener of listeners) {
			listener([
				{ namespace: NAMESPACE, tableName: 'notes', rowId: row.id },
			] as never);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));

		const path = `${NAMESPACE}/notes/${row.id}.md`;
		expect(readFileSync(join(folder, path), 'utf8')).toContain(
			'title: Tuesday',
		);
		expect((await invoke(catalog, 'status')).content).toBe('Nothing to push.');

		writeFileSync(
			join(folder, path),
			`---\nid: ${row.id}\ntitle: Wednesday\ntags:\n  - work\n---\nShip Monday.\n`,
		);

		const status = await invoke(catalog, 'status');
		expect(status.content).toContain('modified');
		expect(status.content).toContain('content, title');

		const pushed = await invoke(catalog, 'push');
		expect(pushed.isError).toBe(false);
		expect(pushed.content).toBe('1 updated.');
		expect(pushed.details).toMatchObject({
			patched: 1,
			created: 0,
			deleted: 0,
			skipped: [],
		});

		expect((await notes.get(row.id)).data).toMatchObject({
			title: 'Wednesday',
			content: 'Ship Monday.\n',
		});
		// Settled: the receipt moved with the push, so the folder has nothing left
		// to say and the field is no longer held back from the renderer.
		expect((await invoke(catalog, 'status')).content).toBe('Nothing to push.');
	} finally {
		await epicenter[Symbol.asyncDispose]();
	}
});

test('a file that lost its receipt is named and refused, not sent', async () => {
	// The one refusal a person has to act on, so `push` reports it in full rather
	// than reporting success over it.
	const path = `${NAMESPACE}/notes/orphan.md`;
	await Bun.write(
		join(folder, path),
		'---\nid: 01JQ0000000000000000000000\ntitle: Stranger\ntags: []\n---\n',
	);

	let patched = false;
	const catalog = createFolderCatalog({
		root: folder,
		receipts,
		lookup: () => lens.tables.notes,
		writer: {
			create: async () => 'unused',
			patch: async () => {
				patched = true;
				return true;
			},
			remove: async () => false,
		},
	});

	const outcome: AgentToolOutcome = await invoke(catalog, 'push');
	expect(patched).toBe(false);
	expect(outcome.content).toBe(`Nothing sent.\nSkipped 1:\n  unbased  ${path}`);
});

test('an unknown verb is refused rather than silently doing nothing', async () => {
	const catalog = createFolderCatalog({
		root: folder,
		receipts,
		lookup: () => lens.tables.notes,
		writer: {
			create: async () => 'unused',
			patch: async () => false,
			remove: async () => false,
		},
	});
	const outcome = await invoke(catalog, 'pull');
	expect(outcome.isError).toBe(true);
	expect(outcome.content).toContain('pull');
});
