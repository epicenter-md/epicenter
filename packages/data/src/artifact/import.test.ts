/**
 * The artifact read back, and the round trip that is the whole promise: what a
 * person exports is what they get when they import it again (ADR-0267/0268).
 *
 * The round trip is proven end to end rather than by inspecting bytes: export a
 * live workspace, read the files back into an envelope, apply that envelope to
 * a fresh store, and compare what the two stores hold. A frontmatter emitter
 * that retyped a value or a codec that lost a body shows up here as a
 * difference between two workspaces, which is the failure a person would
 * actually suffer.
 */
import { describe, expect, test } from 'bun:test';
import { defineData, field } from '@epicenter/data/definition';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createMemoryRecord, openMemory } from '../store/memory.js';
import { syncEngineOf } from '../store/store.js';
import { renderWorkspace } from './render.js';
import { readArtifact } from './import.js';

type MetaRoot = {
	getAttr(key: string): unknown;
	setAttr(key: string, value: unknown): void;
};

const workspace = defineData({
	id: 'so.epicenter.honeycrisp',
	kv: { theme: field.string() },
	tables: {
		folders: { fields: { name: field.string() } },
		notes: {
			fields: {
				title: field.string(),
				code: field.string(),
				flag: field.string(),
				pinned: field.boolean(),
				count: field.number(),
				tags: field.tags(),
				folderId: field.nullable(field.string()),
			},
			document: {
				file: {
					serialize: (doc) =>
						String((doc.get('meta') as MetaRoot).getAttr('body') ?? ''),
					deserialize: (text, doc) => {
						(doc.get('meta') as MetaRoot).setAttr('body', text);
					},
				},
			},
		},
	},
});

/** A workspace with one of everything the artifact has to carry. */
async function seeded() {
	const data = openMemory(workspace);
	data.kv.update({ theme: 'dark' });
	const folder = data.tables.folders.create({ name: 'Inbox' });
	const note = data.tables.notes.create({
		// Values chosen for the ways YAML retypes things when nobody quotes:
		// a numeric-looking string, a boolean-looking one, and a date.
		title: '007',
		// The two that a bare emitter would hand back as a number and a boolean.
		code: '123',
		flag: 'true',
		pinned: false,
		count: 3,
		tags: ['no', '2024-03-05'],
		folderId: folder.id,
	});
	const opened = await data.tables.notes.openDocument(note.id);
	using handle = expectOk(opened);
	if (handle === undefined) throw new Error('the document should open');
	handle.get('meta').setAttr('body' as never, 'buy milk\n\n---\nnot a fence' as never);
	return { data, folder, note };
}

describe('readArtifact (ADR-0267/0268)', () => {
	test('an exported workspace imports back into an identical one', async () => {
		const { data, note } = await seeded();
		const exported = expectOk(await renderWorkspace(data, workspace));

		const envelope = expectOk(readArtifact(exported, workspace));
		await using restored = openMemory(workspace);
		expect(
			syncEngineOf(restored.store).applyRemote(envelope).error,
		).toBeNull();

		// Every scalar, at the same id, read through the same lens.
		expect(restored.tables.notes.list().rows).toHaveLength(1);
		expect(restored.tables.folders.list().rows).toHaveLength(1);
		expect(restored.kv.get().data).toEqual({ theme: 'dark' });
		expect(restored.kv.get().data).toEqual(data.kv.get().data);
		expect(restored.tables.notes.list()).toEqual(data.tables.notes.list());
		expect(restored.tables.folders.list()).toEqual(data.tables.folders.list());

		// And the prose, through the codec, `---` fence and all.
		const opened = await restored.tables.notes.openDocument(note.id);
		using handle = expectOk(opened);
		expect(handle?.get('meta').getAttr('body' as never)).toBe(
			'buy milk\n\n---\nnot a fence',
		);
		await data.store[Symbol.asyncDispose]();
	});

	test('a value keeps its type, so a string that looks like a number stays one', async () => {
		const { data, note } = await seeded();
		const exported = expectOk(await renderWorkspace(data, workspace));
		const envelope = expectOk(readArtifact(exported, workspace));
		await using restored = openMemory(workspace);
		syncEngineOf(restored.store).applyRemote(envelope);

		const row = expectOk(restored.tables.notes.get(note.id));
		expect(row?.title).toBe('007');
		expect(row?.code).toBe('123');
		expect(row?.flag).toBe('true');
		expect(row?.pinned).toBe(false);
		expect(row?.count).toBe(3);
		expect(row?.tags).toEqual(['no', '2024-03-05']);
		await data.store[Symbol.asyncDispose]();
	});

	test('a row the declaration no longer names survives the round trip', async () => {
		// The export carries it (the artifact is not read through the lens), so
		// the import has to put it back, or a release upgrade plus an export and
		// an import would quietly delete it.
		const record = createMemoryRecord();
		const withLegacy = openMemory(workspace, record);
		const made = withLegacy.tables.notes.create({
			title: 'Groceries',
			code: '1',
			flag: 'no',
			pinned: false,
			count: 0,
			tags: [],
			folderId: null,
		});
		withLegacy.tables.notes.update(made.id, { legacy: 'kept' } as never);
		const exported = expectOk(await renderWorkspace(withLegacy, workspace));
		await withLegacy.store[Symbol.asyncDispose]();

		const envelope = expectOk(readArtifact(exported, workspace));
		await using restored = openMemory(workspace);
		syncEngineOf(restored.store).applyRemote(envelope);
		expect(restored.stored().tables.get('notes')?.get(made.id)).toEqual({
			title: 'Groceries',
			code: '1',
			flag: 'no',
			pinned: false,
			count: 0,
			tags: [],
			folderId: null,
			legacy: 'kept',
		});
		record.close();
	});

	test('a hand-typed value that was never quoted reads as the string it looks like', () => {
		const files = new Map([
			['notes/aaaaaaaaaaaaaaaaaaaaaaaa.md', '---\ntitle: Groceries\n---\n'],
		]);
		const envelope = expectOk(readArtifact(files, workspace));
		const restored = openMemory(workspace);
		syncEngineOf(restored.store).applyRemote(envelope);
		expect(
			restored.stored().tables.get('notes')?.get('aaaaaaaaaaaaaaaaaaaaaaaa'),
		).toEqual({ title: 'Groceries' });
		void restored.store[Symbol.asyncDispose]();
	});

	test('a file that is not a row file refuses the whole import', () => {
		const files = new Map([['notes/aaaa.md', 'no frontmatter here']]);
		const refused = expectErr(readArtifact(files, workspace));
		expect(refused.name).toBe('MalformedFile');
	});

	test('a body under a table with no codec refuses, rather than dropping the prose', () => {
		const files = new Map([['folders/aaaa.md', '---\nname: "Inbox"\n---\n\nprose\n']]);
		const refused = expectErr(readArtifact(files, workspace));
		expect(refused.name).toBe('UncodedBody');
	});

	test('a codec that throws on a body refuses the whole import', () => {
		const breaking = defineData({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: {
				notes: {
					fields: { title: field.string() },
					document: {
						file: {
							serialize: () => '',
							deserialize: () => {
								throw new Error('not my format');
							},
						},
					},
				},
			},
		});
		const files = new Map([['notes/aaaa.md', '---\ntitle: "x"\n---\n\nprose\n']]);
		const refused = expectErr(readArtifact(files, breaking));
		expect(refused.name).toBe('BodyUnreadable');
	});

	test('a file that is not part of the artifact is left alone', () => {
		const files = new Map([
			['.DS_Store', 'binary junk'],
			['README.md', '# not a row'],
			['notes/aaaaaaaaaaaaaaaaaaaaaaaa.md', '---\ntitle: "kept"\n---\n'],
		]);
		const envelope = expectOk(readArtifact(files, workspace));
		const restored = openMemory(workspace);
		syncEngineOf(restored.store).applyRemote(envelope);
		expect([...(restored.stored().tables.get('notes')?.keys() ?? [])]).toEqual([
			'aaaaaaaaaaaaaaaaaaaaaaaa',
		]);
		void restored.store[Symbol.asyncDispose]();
	});
});
