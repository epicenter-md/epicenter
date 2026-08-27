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
	test('exports kv.json, one file per table, and one file per document', async () => {
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

		const exported = await exportWorkspace(data, workspace);
		if (exported.error !== null) throw exported.error;
		const files = exported.data;

		expect(JSON.parse(files.get('kv.json') ?? 'null')).toEqual({ theme: 'dark' });

		const notes = JSON.parse(files.get('tables/notes.json') ?? 'null') as Record<
			string,
			{ title: string }
		>;
		expect(Object.keys(notes)).toEqual([made.id]);
		expect(notes[made.id]).toMatchObject({ title: 'Groceries' });

		expect(files.get(`documents/notes/${made.id}.txt`)).toBe('buy milk');
	});

	test('a row the declaration no longer names is still in the artifact', async () => {
		await using data = openMemory(workspace);
		const made = data.tables.notes.create({ title: 'Groceries' });
		// A value written under an older declaration: the lens cannot see it,
		// and the artifact must carry it anyway.
		data.tables.notes.update(made.id, { legacy: 'kept' } as never);

		const exported = await exportWorkspace(data, workspace);
		if (exported.error !== null) throw exported.error;
		const notes = JSON.parse(
			exported.data.get('tables/notes.json') ?? 'null',
		) as Record<string, Record<string, unknown>>;
		expect(notes[made.id]?.legacy).toBe('kept');
		expect(data.tables.notes.list().rows[0]).not.toHaveProperty('legacy');
	});
});
