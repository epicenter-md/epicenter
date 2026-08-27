/**
 * Honeycrisp's mirror, end to end through a real store (ADR-0271).
 *
 * The seam this proves is the one that was genuinely new: a commit becomes a
 * request carrying a rendered file at a path. `fetch` is injected, so the host
 * is not involved and what is asserted is exactly what would have crossed the
 * wire.
 */

import { expect, test } from 'bun:test';
import { openMemory } from '@epicenter/data/memory';
import { InstantString } from '@epicenter/field';
import { expectOk } from 'wellcrafted/testing';
import { attachMirror } from './mirror.js';
import { honeycrispDefinition } from './workspace/index.js';

const AT = InstantString.fromDate(new Date('2026-08-10T00:00:00.000Z'));

/** Every request the mirror made, in order, as (method, path, body). */
function recordingFetch() {
	const sent: { method: string; url: string; body: string }[] = [];
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		sent.push({
			method: init?.method ?? 'GET',
			url: String(input),
			body: typeof init?.body === 'string' ? init.body : '',
		});
		return new Response(null, { status: 204 });
	}) as typeof globalThis.fetch;
	return { sent, fetch };
}

/** Let the mirror's queued renders run; every one of them is asynchronous. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function note(title: string) {
	return {
		folderId: null,
		title,
		preview: '',
		pinned: false,
		createdAt: AT,
		updatedAt: AT,
		deletedAt: null,
	};
}

test('a created note becomes one file at its own path', async () => {
	await using data = openMemory(honeycrispDefinition);
	const { sent, fetch } = recordingFetch();
	using _mirror = attachMirror({ data, workspace: 'account', fetch });
	await settle();
	sent.length = 0;

	const made = data.tables.notes.create(note('Groceries'));
	await settle();

	const written = sent.find((request) =>
		request.url.endsWith(`/notes/${made.id}.md`),
	);
	expect(written?.method).toBe('PUT');
	expect(written?.url).toBe(
		`/api/mirror/account/so.epicenter.honeycrisp/notes/${made.id}.md`,
	);
	expect(written?.body).toContain('title: "Groceries"');
});

test('the boot pass renders what is already there', async () => {
	// A workspace changes while the application is closed: another device syncs,
	// and the folder is stale until something renders it whole.
	await using data = openMemory(honeycrispDefinition);
	const made = data.tables.notes.create(note('written before boot'));

	const { sent, fetch } = recordingFetch();
	using _mirror = attachMirror({ data, workspace: 'account', fetch });
	await settle();

	expect(sent.map(({ url }) => url)).toContain(
		`/api/mirror/account/so.epicenter.honeycrisp/notes/${made.id}.md`,
	);
	expect(sent.map(({ url }) => url)).toContain(
		'/api/mirror/account/so.epicenter.honeycrisp/kv.json',
	);
});

test('a deleted note unlinks its file', async () => {
	await using data = openMemory(honeycrispDefinition);
	const { sent, fetch } = recordingFetch();
	using _mirror = attachMirror({ data, workspace: 'account', fetch });
	const made = data.tables.notes.create(note('Groceries'));
	await settle();
	sent.length = 0;

	data.tables.notes.delete(made.id);
	await settle();

	const removed = sent.find((request) =>
		request.url.endsWith(`/notes/${made.id}.md`),
	);
	expect(removed?.method).toBe('DELETE');
});

test('the on-this-device workspace renders to its own folder', async () => {
	await using data = openMemory(honeycrispDefinition);
	const { sent, fetch } = recordingFetch();
	using _mirror = attachMirror({ data, workspace: 'on-this-device', fetch });
	const made = data.tables.notes.create(note('local only'));
	await settle();

	expect(sent.map(({ url }) => url)).toContain(
		`/api/mirror/on-this-device/so.epicenter.honeycrisp/notes/${made.id}.md`,
	);
});

test('disposing stops the mirror', async () => {
	await using data = openMemory(honeycrispDefinition);
	const { sent, fetch } = recordingFetch();
	const mirror = attachMirror({ data, workspace: 'account', fetch });
	await settle();
	mirror[Symbol.dispose]();
	sent.length = 0;

	data.tables.notes.create(note('after disposal'));
	await settle();
	expect(sent).toEqual([]);
});

test('a note body edit reaches the file, through the real codec', async () => {
	// Honeycrisp declares `derive`, so a body edit stamps title/preview and
	// updatedAt, which IS a table commit and is what the subscription hears.
	// A table declaring a document block and no derivation would not fire here;
	// that gap is real and belongs to the store, not this follower.
	await using data = openMemory(honeycrispDefinition);
	const { sent, fetch } = recordingFetch();
	using _mirror = attachMirror({ data, workspace: 'account', fetch });
	const made = data.tables.notes.create(note(''));
	await settle();
	sent.length = 0;

	{
		const opened = await data.tables.notes.openDocument(made.id);
		using handle = expectOk(opened);
		if (handle === undefined) throw new Error('the note has no document');
		honeycrispDefinition.tables.notes.document.file.deserialize(
			'# Groceries\n\n- buy milk',
			handle,
		);
	}
	await settle();

	const written = sent.findLast((request) =>
		request.url.endsWith(`/notes/${made.id}.md`),
	);
	expect(written?.method).toBe('PUT');
	expect(written?.body).toContain('# Groceries');
	// `* ` rather than the `- ` that went in: the codec parses to ProseMirror
	// and serializes back with its own bullet marker, so Markdown round-trips
	// as a document rather than as text. That is the codec's normalization
	// showing through, and the file is what a person will see.
	expect(written?.body).toContain('* buy milk');
	// The derivation rode along: the row's title came from the body.
	expect(written?.body).toContain('title: "Groceries"');
});
