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

		const files = await exportDocuments(data, withCodec);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({
			table: 'notes',
			rowId: made.id,
			extension: 'txt',
			text: 'buy milk',
		});

		// The codec's deserialize reconstructs the document from the exported text.
		const codec = withCodec.tables.notes.document?.file;
		if (codec === undefined) throw new Error('the codec should exist');
		const reborn = codec.deserialize(files[0]!.text) as Y.Doc;
		expect((reborn.get('meta') as unknown as TitleRoot).getAttr('title')).toBe(
			'buy milk',
		);
	});

	test('a table with no file codec contributes no files', async () => {
		const plain = defineData({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: { notes: { fields: { title: field.string() } } },
		});
		await using data = openMemory(plain);
		data.tables.notes.create({ title: 'Groceries' });
		expect(await exportDocuments(data, plain)).toEqual([]);
	});
});
