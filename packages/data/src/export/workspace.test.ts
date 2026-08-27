import { defineData, field } from '@epicenter/data/definition';
import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';
import { openMemory } from '../store/bun.js';
import { exportWorkspace } from './workspace.js';

type TitleRoot = {
	getAttr(key: string): unknown;
	setAttr(key: string, value: unknown): void;
};

const workspace = defineData({
	id: 'so.epicenter.honeycrisp',
	kv: { theme: field.string() },
	tables: {
		notes: {
			fields: { title: field.string() },
			document: {
				file: {
					extension: 'txt',
					serialize: (doc) =>
						String((doc.get('meta') as TitleRoot).getAttr('title') ?? ''),
					deserialize: (text) => {
						const doc = new Y.Doc();
						(doc.get('meta') as unknown as TitleRoot).setAttr('title', text);
						return doc;
					},
				},
			},
		},
	},
});

describe('exportWorkspace (ADR-0267)', () => {
	test('exports kv.json, tables.json, and one file per document', async () => {
		await using data = openMemory(workspace);
		data.kv.update({ theme: 'dark' });
		const made = data.tables.notes.create({ title: 'Groceries' });
		const opened = await data.tables.notes.openDocument(made.id);
		const handle = opened.data;
		if (handle === undefined || handle === null) {
			throw new Error('the document should open');
		}
		handle.get('meta').setAttr('title' as never, 'buy milk' as never);
		handle[Symbol.dispose]();

		const files = await exportWorkspace(data, workspace);

		expect(JSON.parse(files.get('kv.json') ?? 'null')).toEqual({ theme: 'dark' });

		const tables = JSON.parse(files.get('tables.json') ?? 'null') as {
			notes: { id: string; title: string }[];
		};
		expect(tables.notes).toHaveLength(1);
		expect(tables.notes[0]).toMatchObject({ id: made.id, title: 'Groceries' });

		expect(files.get(`documents/notes/${made.id}.txt`)).toBe('buy milk');
	});
});
