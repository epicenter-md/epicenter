/**
 * Honeycrisp's own export and import, end to end (ADR-0267/0268).
 *
 * The promise this app makes about a person's data: what comes out is a folder
 * of Markdown files they can read in any vault tool, and what goes back in is
 * the workspace they left. Proven against the real definition and the real
 * ProseMirror codec, not a stand-in, because the codec is where the prose can
 * actually be lost.
 */
import { expect, test } from 'bun:test';
import { exportWorkspace, readArtifact } from '@epicenter/data/artifact';
import { openMemory } from '@epicenter/data/memory';
import { syncEngineOf } from '@epicenter/data/engine';
import { InstantString } from '@epicenter/field';
import { expectOk } from 'wellcrafted/testing';
import { honeycrispDefinition, NOTE_BODY } from './index.js';

const AT = InstantString.fromDate(new Date('2026-08-10T00:00:00.000Z'));

const MARKDOWN = [
	'# Groceries',
	'',
	'- [ ] buy milk',
	'- [x] ~~pay rent~~',
	'',
	'Some **bold** and *italic* prose.',
].join('\n');

function seed() {
	const data = openMemory(honeycrispDefinition);
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

test('a workspace exports to Markdown files and imports back whole', async () => {
	const { data, note } = seed();
	{
		const opened = await data.tables.notes.openDocument(note.id);
		using handle = expectOk(opened);
		if (handle === undefined) throw new Error('the note has no document');
		honeycrispDefinition.tables.notes.document.file.deserialize(
			MARKDOWN,
			handle,
		);
	}

	const files = expectOk(await exportWorkspace(data, honeycrispDefinition));
	// One file per row, and the note's file is prose a person can read.
	expect([...files.keys()].sort()).toEqual(
		[`folders/${data.tables.folders.list().rows[0]?.id}.md`, 'kv.json', `notes/${note.id}.md`].sort(),
	);
	const file = files.get(`notes/${note.id}.md`) ?? '';
	expect(file).toContain('title: "Groceries"');
	expect(file).toContain('- [ ] buy milk');

	const envelope = expectOk(readArtifact(files, honeycrispDefinition));
	await using restored = openMemory(honeycrispDefinition);
	expect(syncEngineOf(restored.store).applyRemote(envelope).error).toBeNull();

	expect(restored.tables.notes.list()).toEqual(data.tables.notes.list());
	expect(restored.tables.folders.list()).toEqual(data.tables.folders.list());

	// And the prose came back as the same Markdown, through the real codec.
	const reopened = await restored.tables.notes.openDocument(note.id);
	using handle = expectOk(reopened);
	if (handle === undefined) throw new Error('the note lost its document');
	expect(
		honeycrispDefinition.tables.notes.document.file.serialize(handle),
	).toBe(MARKDOWN);
	await data.store[Symbol.asyncDispose]();
});

test('a note with no prose exports as frontmatter alone and still imports', async () => {
	const { data, note } = seed();
	const files = expectOk(await exportWorkspace(data, honeycrispDefinition));
	expect(files.get(`notes/${note.id}.md`)).not.toContain('\n\n');

	const envelope = expectOk(readArtifact(files, honeycrispDefinition));
	await using restored = openMemory(honeycrispDefinition);
	syncEngineOf(restored.store).applyRemote(envelope);
	expect(expectOk(restored.tables.notes.get(note.id))?.title).toBe('Groceries');
	const reopened = await restored.tables.notes.openDocument(note.id);
	using handle = expectOk(reopened);
	expect(handle?.get(NOTE_BODY)).toBeDefined();
	await data.store[Symbol.asyncDispose]();
});
