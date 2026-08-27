import { defineData, field } from '@epicenter/data/definition';
import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';
import { openMemory } from '../store/bun.js';
import { exportDocuments } from './documents.js';

type TitleRoot = {
	getAttr(key: string): unknown;
	setAttr(key: string, value: unknown): void;
};

const withCodec = defineData({
	id: 'so.epicenter.honeycrisp',
	kv: {},
	tables: {
		notes: {
			fields: { title: field.string() },
			document: {
				file: {
					serialize: (doc) =>
						String((doc.get('meta') as TitleRoot).getAttr('title') ?? ''),
					deserialize: (text, doc) => {
						(doc.get('meta') as TitleRoot).setAttr('title', text);
					},
				},
			},
		},
	},
});

describe('exportDocuments (ADR-0267)', () => {
	test('serializes each row document through its file codec, and it round-trips', async () => {
		await using data = openMemory(withCodec);
		const made = data.tables.notes.create({ title: 'Groceries' });
		const opened = await data.tables.notes.openDocument(made.id);
		const handle = opened.data;
		if (handle === undefined || handle === null) {
			throw new Error('the document should open');
		}
		handle.get('meta').setAttr('title' as never, 'buy milk' as never);
		handle[Symbol.dispose]();

		const exported = await exportDocuments(data, withCodec);
		if (exported.error !== null) throw exported.error;
		const files = exported.data;
		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({
			table: 'notes',
			rowId: made.id,
			text: 'buy milk',
		});

		// The codec's deserialize fills a fresh document from the exported text.
		const codec = withCodec.tables.notes.document?.file;
		if (codec === undefined) throw new Error('the codec should exist');
		const reborn = new Y.Doc();
		codec.deserialize(
			files[0]!.text,
			reborn as unknown as { get(root: string): unknown },
		);
		expect((reborn.get('meta') as unknown as TitleRoot).getAttr('title')).toBe(
			'buy milk',
		);
		reborn.destroy();
	});

	test('a table with no file codec contributes no files', async () => {
		const plain = defineData({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: { notes: { fields: { title: field.string() } } },
		});
		await using data = openMemory(plain);
		data.tables.notes.create({ title: 'Groceries' });
		const exported = await exportDocuments(data, plain);
		if (exported.error !== null) throw exported.error;
		expect(exported.data).toEqual([]);
	});

	test('a document that cannot be read abandons the whole export', async () => {
		await using data = openMemory(withCodec);
		const made = data.tables.notes.create({ title: 'Groceries' });

		// An opener that reports storage trouble for this row, standing in for a
		// chain that cannot be replayed. The export must not skip past it: the
		// artifact feeds an import that replaces the workspace, so a body missing
		// here is a body deleted everywhere.
		const failing = {
			stored: () => data.store.stored(),
			tables: {
				notes: {
					openDocument: async () => ({
						data: null,
						error: { name: 'HydrationFailed', address: `notes/${made.id}` },
					}),
				},
			},
		};

		const exported = await exportDocuments(failing, withCodec);
		expect(exported.data).toBeNull();
		if (exported.error?.name !== 'DocumentUnreadable') {
			throw new Error(`expected DocumentUnreadable, got ${exported.error?.name}`);
		}
		expect(exported.error.table).toBe('notes');
		expect(exported.error.rowId).toBe(made.id);
	});
});
