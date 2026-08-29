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
import {
	type ArtifactDocument,
	readArtifact,
	renderArtifact,
} from '@epicenter/data/artifact';
import { encodeEnvelope, syncEngineOf } from '@epicenter/data/engine';

/**
 * Pack what `readArtifact` returns into what today's store still accepts.
 *
 * `readArtifact` returns documents, because a mint uploads them one at a time
 * to their own addresses and a local import writes them one at a time into a
 * chain (ADR-0286). This packing goes when the positional log does.
 */
const asEnvelope = (documents: readonly ArtifactDocument[]) =>
	encodeEnvelope([...documents]);

import { openMemory } from '@epicenter/data/memory';
import { InstantString } from '@epicenter/field';
import { expectOk } from 'wellcrafted/testing';
import { honeycrispDefinition, NOTE_BODY } from './index.js';

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

test('a store exports to Markdown files and imports back whole', async () => {
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

	const envelope = asEnvelope(
		expectOk(readArtifact(files, honeycrispDefinition)),
	);
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
	const files = await collect(renderArtifact(data, honeycrispDefinition));
	expect(files.get(`notes/${note.id}.md`)).not.toContain('\n\n');

	const envelope = asEnvelope(
		expectOk(readArtifact(files, honeycrispDefinition)),
	);
	await using restored = openMemory(honeycrispDefinition);
	syncEngineOf(restored.store).applyRemote(envelope);
	expect(expectOk(restored.tables.notes.get(note.id))?.title).toBe('Groceries');
	const reopened = await restored.tables.notes.openDocument(note.id);
	using handle = expectOk(reopened);
	expect(handle?.get(NOTE_BODY)).toBeDefined();
	await data.store[Symbol.asyncDispose]();
});
