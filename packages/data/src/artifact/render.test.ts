import { describe, expect, test } from 'bun:test';
import { defineData, field } from '@epicenter/data/definition';
import { openMemory } from '../store/memory.js';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { parseData } from '@epicenter/data/definition';
import { renderRow, renderWorkspace } from './render.js';

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

/** The parsed definition `renderRow` reads codecs from. */
function parsed(definition: Parameters<typeof parseData>[0]) {
	return expectOk(parseData(definition));
}

describe('renderRow is the unit (ADR-0271)', () => {
	test('one row becomes one file: fields on top, prose underneath', async () => {
		await using data = openMemory(workspace);
		const made = data.tables.notes.create({ title: 'Groceries' });
		const opened = await data.tables.notes.openDocument(made.id);
		using handle = expectOk(opened);
		if (handle === undefined) throw new Error('the document should open');
		handle.get('meta').setAttr('title' as never, 'buy milk' as never);

		const rendered = expectOk(
			await renderRow(data, parsed(workspace), 'notes', made.id),
		);
		expect(rendered.path).toBe(`notes/${made.id}.md`);
		expect(rendered.contents).toBe(
			['---', 'title: "Groceries"', '---', '', 'buy milk', ''].join('\n'),
		);
	});

	test('a row that is gone renders no contents, which is the unlink signal', async () => {
		// What a subscriber needs for a deletion: the ids a commit touched include
		// the ones it removed, so the same call answers write-this and unlink-that.
		await using data = openMemory(workspace);
		const made = data.tables.notes.create({ title: 'Groceries' });
		data.tables.notes.delete(made.id);

		const rendered = expectOk(
			await renderRow(data, parsed(workspace), 'notes', made.id),
		);
		expect(rendered.path).toBe(`notes/${made.id}.md`);
		expect(rendered.contents).toBeUndefined();
	});

	test('a table with no document block renders frontmatter alone', async () => {
		const scalarOnly = defineData({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: { folders: { fields: { name: field.string() } } },
		});
		await using data = openMemory(scalarOnly);
		const made = data.tables.folders.create({ name: 'Inbox' });

		const rendered = expectOk(
			await renderRow(data, parsed(scalarOnly), 'folders', made.id),
		);
		expect(rendered.contents).toBe(
			['---', 'name: "Inbox"', '---', ''].join('\n'),
		);
	});

	test('a codec that throws is a refusal, not an escaping exception', async () => {
		// The contract is a Result. A codec that throws is a case a person needs
		// told, not a stack trace mid-write.
		const breaking = defineData({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: {
				notes: {
					fields: { title: field.string() },
					document: {
						file: {
							serialize: () => {
								throw new Error('this document is not my shape');
							},
							deserialize: () => undefined,
						},
					},
				},
			},
		});
		await using data = openMemory(breaking);
		const made = data.tables.notes.create({ title: 'Groceries' });

		const refused = expectErr(
			await renderRow(data, parsed(breaking), 'notes', made.id),
		);
		expect(refused.name).toBe('BodyUnwritable');
	});

	test('a field the declaration dropped is in the file, because the read is faithful', async () => {
		await using data = openMemory(workspace);
		const made = data.tables.notes.create({ title: 'Groceries' });
		data.tables.notes.update(made.id, { legacy: 'kept' } as never);

		const rendered = expectOk(
			await renderRow(data, parsed(workspace), 'notes', made.id),
		);
		expect(rendered.contents).toContain('legacy: "kept"');
		expect(data.tables.notes.list().rows[0]).not.toHaveProperty('legacy');
	});
});

describe('renderWorkspace is renderRow in a loop (ADR-0267/0268)', () => {
	test('exports kv.json and one markdown file per row, fields above the body', async () => {
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

		const exported = await renderWorkspace(data, workspace);
		if (exported.error !== null) throw exported.error;
		const files = exported.data;

		expect(JSON.parse(files.get('kv.json') ?? 'null')).toEqual({
			theme: 'dark',
		});

		// The row is one file: its id is the path, its fields the frontmatter
		// (strings always quoted, so every value re-reads as itself), and its
		// document the body (ADR-0268).
		expect(files.get(`notes/${made.id}.md`)).toBe(
			['---', 'title: "Groceries"', '---', '', 'buy milk', ''].join('\n'),
		);
		expect([...files.keys()].sort()).toEqual([
			'kv.json',
			`notes/${made.id}.md`,
		]);
	});

	test('a row the declaration no longer names is still in the artifact', async () => {
		await using data = openMemory(workspace);
		const made = data.tables.notes.create({ title: 'Groceries' });
		// A value written under an older declaration: the lens cannot see it,
		// and the artifact must carry it anyway.
		data.tables.notes.update(made.id, { legacy: 'kept' } as never);

		const exported = await renderWorkspace(data, workspace);
		if (exported.error !== null) throw exported.error;
		const file = exported.data.get(`notes/${made.id}.md`) ?? '';
		expect(file).toContain('legacy: "kept"');
		expect(data.tables.notes.list().rows[0]).not.toHaveProperty('legacy');
	});

	test('a table without a document block exports frontmatter-only files', async () => {
		const scalarOnly = defineData({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: { folders: { fields: { name: field.string() } } },
		});
		await using data = openMemory(scalarOnly);
		const made = data.tables.folders.create({ name: 'Inbox' });

		const exported = await renderWorkspace(data, scalarOnly);
		if (exported.error !== null) throw exported.error;
		expect(exported.data.get(`folders/${made.id}.md`)).toBe(
			['---', 'name: "Inbox"', '---', ''].join('\n'),
		);
	});
});
