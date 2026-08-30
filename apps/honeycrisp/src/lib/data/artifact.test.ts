/**
 * Honeycrisp's own export and import, end to end (ADR-0267/0268).
 *
 * The promise this app makes about a person's data: what comes out is a folder
 * of Markdown files they can read in any vault tool, and what goes back in is
 * the store they left. Proven against the real definition and the real
 * ProseMirror codec, not a stand-in, because the codec is where the prose can
 * actually be lost.
 */
import { expect, test } from 'bun:test';
import { readArtifact, renderArtifact } from '@epicenter/data/artifact';
import { syncEngineOf } from '@epicenter/data/engine';
import { openMemory } from '@epicenter/data/memory';
import { InstantString } from '@epicenter/field';
import { expectOk } from 'wellcrafted/testing';
import { honeycrispDefinition } from './index.js';

/** The notes table's real codec, which is what these tests are about. */
const noteFile = honeycrispDefinition.tables.notes.file;
if (noteFile === undefined) throw new Error('the notes table declares a codec');

const AT = InstantString.fromDate(new Date('2026-08-10T00:00:00.000Z'));

/** Collect the render stream into a map, which is what an assertion wants. */
async function collect(
	stream: AsyncIterable<{
		data: { path: string; contents?: string } | null;
		error: unknown;
	}>,
): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	for await (const rendered of stream) {
		if (rendered.error !== null) throw rendered.error;
		const { path, contents } = rendered.data as {
			path: string;
			contents?: string;
		};
		if (contents !== undefined) files.set(path, contents);
	}
	return files;
}

const MARKDOWN = [
	'# Groceries',
	'',
	'- [ ] buy milk',
	'- [x] ~~pay rent~~',
	'',
	'Some **bold** and *italic* prose.',
].join('\n');

async function seed() {
	const data = await openMemory(honeycrispDefinition);
	const folder = data.tables.folders.create({ name: 'Inbox', icon: null });
	const note = data.tables.notes.create({
		folderId: folder.id,
		title: 'Groceries',
		preview: '',
		pinned: true,
		createdAt: AT,
		updatedAt: AT,
		deletedAt: null,
	});
	return { data, folder, note };
}

test('a store exports to Markdown files and imports back whole', async () => {
	const { data, note } = await seed();
	const content = data.tables.notes.content(note.id);
	if (content === undefined) throw new Error('the note has no content');
	expectOk(
		noteFile.deserialize({ data: {}, content: MARKDOWN }, content.types),
	);

	const files = await collect(renderArtifact(data, honeycrispDefinition));
	// One file per row, and the note's file is prose a person can read.
	expect([...files.keys()].sort()).toEqual(
		[
			`folders/${data.tables.folders.list().rows[0]?.id}.md`,
			'kv.json',
			`notes/${note.id}.md`,
		].sort(),
	);
	const file = files.get(`notes/${note.id}.md`) ?? '';
	expect(file).toContain('title: "Groceries"');
	expect(file).toContain('- [ ] buy milk');

	const state = expectOk(readArtifact(files, honeycrispDefinition));
	await using restored = await openMemory(honeycrispDefinition);
	expect(syncEngineOf(restored.store).applyRemote(state).error).toBeNull();

	expect(restored.tables.notes.list()).toEqual(data.tables.notes.list());
	expect(restored.tables.folders.list()).toEqual(data.tables.folders.list());

	// And the prose came back as the same Markdown, through the real codec.
	const back = restored.tables.notes.content(note.id);
	if (back === undefined) throw new Error('the note lost its content');
	const row = expectOk(restored.tables.notes.get(note.id));
	if (row === undefined) throw new Error('the note lost its row');
	expect(noteFile.serialize({ ...row, ...back.types }).content).toBe(MARKDOWN);
	await data.store[Symbol.asyncDispose]();
});

test('a note with no prose exports as frontmatter alone and still imports', async () => {
	const { data, note } = await seed();
	const files = await collect(renderArtifact(data, honeycrispDefinition));
	expect(files.get(`notes/${note.id}.md`)).not.toContain('\n\n');

	const state = expectOk(readArtifact(files, honeycrispDefinition));
	await using restored = await openMemory(honeycrispDefinition);
	syncEngineOf(restored.store).applyRemote(state);
	expect(expectOk(restored.tables.notes.get(note.id))?.title).toBe('Groceries');
	// The body is minted with the row, so an empty note still has one.
	expect(restored.tables.notes.content(note.id)?.types.body).toBeDefined();
	await data.store[Symbol.asyncDispose]();
});
