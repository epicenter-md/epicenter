/**
 * `pull` and the base it writes (ADR-0337).
 *
 * The host is a `fetch` here, because what these pin is the application's
 * half: that a pull hands over every file and a manifest describing exactly
 * those files, that it refuses a folder holding unpushed edits, and that
 * `workingCopyChanges` calls an edit what it is. Whether the bytes reach a
 * filesystem is `apps/epicenter/src/checkout.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import {
	defineData,
	defineTable,
	field,
	plainText,
} from '@epicenter/data/definition';
import type * as Y from '@y/y';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openMemory } from '../store/memory.js';
import {
	type CheckoutFile,
	type CheckoutManifest,
	checkoutLine,
	contentHash,
	MANIFEST_PATH,
	pull,
	workingCopyChanges,
} from './checkout.js';

const definition = defineData({
	id: 'so.epicenter.honeycrisp',
	kv: { theme: field.string() },
	tables: {
		notes: defineTable({
			title: field.string(),
			pinned: field.boolean(),
			content: plainText(),
		}),
	},
});

const DATA_ID = definition.id;
const CLOUD = 'https://api.epicenter.so';

/**
 * A host that holds one folder in memory.
 *
 * `GET` hands back what it holds and `PUT` replaces it, which is the whole of
 * the contract `apps/epicenter/src/checkout.ts` implements against a disk.
 */
function fakeHost(initial: Iterable<CheckoutFile> = []) {
	const folder = new Map<string, string>();
	for (const file of initial) folder.set(file.path, file.contents);
	let reachable = true;
	let refusal: number | undefined;
	return {
		folder,
		unplug: () => {
			reachable = false;
		},
		refuse: (status: number) => {
			refusal = status;
		},
		fetch: (async (_input: string | URL, init?: RequestInit) => {
			if (!reachable) throw new Error('no host here');
			if (refusal !== undefined) {
				return new Response(null, { status: refusal });
			}
			if (init?.method === 'PUT') {
				folder.clear();
				for (const line of String(init.body).split('\n')) {
					if (line.trim() === '') continue;
					const file = JSON.parse(line) as CheckoutFile;
					folder.set(file.path, file.contents);
				}
				return new Response(null, { status: 204 });
			}
			return new Response(
				[...folder]
					.map(([path, contents]) => checkoutLine({ path, contents }))
					.join(''),
				{ headers: { 'content-type': 'application/x-ndjson' } },
			);
		}) as typeof globalThis.fetch,
	};
}

async function notebook() {
	const data = await openMemory(definition);
	const note = data.tables.notes.create({ title: 'Groceries', pinned: false });
	const held = data.tables.notes.get(note.id);
	if (held === undefined) throw new Error('the row has no content');
	(held.content as Y.Type).insert(0, ['buy milk']);
	return { data, noteId: note.id };
}

function manifestOf(folder: ReadonlyMap<string, string>): CheckoutManifest {
	return JSON.parse(folder.get(MANIFEST_PATH) as string) as CheckoutManifest;
}

async function pullInto(
	host: ReturnType<typeof fakeHost>,
	data: Awaited<ReturnType<typeof notebook>>['data'],
	options: { discardEdits?: boolean } = {},
) {
	return pull({
		data,
		definition,
		dataId: DATA_ID,
		generation: 7,
		baseURL: CLOUD,
		principalId: 'alice',
		fetch: host.fetch,
		now: () => new Date('2026-09-02T10:00:00.000Z'),
		...options,
	});
}

describe('pull fills the folder and writes the base', () => {
	test('every row is a file, and the manifest names exactly those files', async () => {
		const host = fakeHost();
		const { data, noteId } = await notebook();
		const pulled = expectOk(await pullInto(host, data));

		expect([...host.folder.keys()].sort()).toEqual([
			MANIFEST_PATH,
			'kv.json',
			`notes/${noteId}.md`,
		]);
		expect(pulled.files).toBe(3);

		const manifest = manifestOf(host.folder);
		expect(manifest).toMatchObject({
			baseURL: CLOUD,
			principalId: 'alice',
			dataId: DATA_ID,
			generation: 7,
			pulledAt: '2026-09-02T10:00:00.000Z',
		});
		// The base is the VALUES, not a hash of them: push resolves per field and
		// needs the value to tell "the person changed this" from "the store did".
		// The id is not among them: it is the path, and a second copy of an
		// identifier on disk is a second thing that can be wrong.
		expect(manifest.rows[`notes/${noteId}`]?.values).toEqual({
			title: 'Groceries',
			pinned: false,
		});
		// The body is hashed instead, because it is never merged (ADR-0329).
		expect(manifest.rows[`notes/${noteId}`]?.bodyHash).toBe(
			await contentHash('buy milk'),
		);
		await data[Symbol.asyncDispose]();
	});

	test('an empty folder is filled without a word', async () => {
		// Nothing is there to lose, so there is nothing to ask about.
		const host = fakeHost();
		const { data } = await notebook();
		expectOk(await pullInto(host, data));
		expect(host.folder.has(MANIFEST_PATH)).toBe(true);
		await data[Symbol.asyncDispose]();
	});

	test("a first pull over somebody's own row-shaped files stops and shows them", async () => {
		// The folder holds `drafts/ideas.md` and no manifest, so nothing wrote
		// down what these files are. Filling it would delete that file with no
		// dialog, which is the whole hazard `pull`'s refusal exists for; an
		// absent base is compared against an EMPTY one rather than skipped.
		const host = fakeHost([
			{ path: 'drafts/ideas.md', contents: '---\ntitle: "mine"\n---\n' },
			{ path: 'README.md', contents: 'not a row, not touched' },
		]);
		const { data } = await notebook();
		const refused = expectErr(await pullInto(host, data));
		expect(refused.name).toBe('WorkingCopyDirty');
		if (refused.name !== 'WorkingCopyDirty') throw new Error('unreachable');
		expect(refused.changes.rows).toEqual([
			expect.objectContaining({ table: 'drafts', rowId: 'ideas', added: true }),
		]);
		// And the dialog can say Honeycrisp does not recognize this folder.
		expect(refused.base).toBeUndefined();
		expect(host.folder.has('drafts/ideas.md')).toBe(true);
		await data[Symbol.asyncDispose]();
	});

	test('a mangled manifest is no base, not a clean folder', async () => {
		// A Dropbox conflict copy, a hand edit, a half-written file. Reading
		// `undefined` as "never pulled" and "never pulled" as "clean" is how one
		// hidden file bypasses the one refusal in this module.
		const host = fakeHost();
		const { data } = await notebook();
		expectOk(await pullInto(host, data));
		host.folder.set(MANIFEST_PATH, '{"rows":');

		const refused = expectErr(await pullInto(host, data));
		expect(refused.name).toBe('WorkingCopyDirty');
		await data[Symbol.asyncDispose]();
	});

	test("another account's manifest is not this store's base", async () => {
		// ADR-0325 binds a database to one authority; this is the same rule one
		// layer out, where the evidence is a file rather than a transaction.
		// Alice pulls, Bob signs in on the same machine, Bob pulls.
		const host = fakeHost();
		const { data } = await notebook();
		expectOk(await pullInto(host, data));
		const alice = JSON.parse(
			host.folder.get(MANIFEST_PATH) as string,
		) as CheckoutManifest;
		host.folder.set(
			MANIFEST_PATH,
			JSON.stringify({ ...alice, principalId: 'bob' }),
		);

		const refused = expectErr(await pullInto(host, data));
		expect(refused.name).toBe('WorkingCopyDirty');
		if (refused.name !== 'WorkingCopyDirty') throw new Error('unreachable');
		expect(refused.base).toBeUndefined();
		await data[Symbol.asyncDispose]();
	});

	test('nothing answering and a host saying no are different failures', async () => {
		// The repair differs and one of them has none: a retry cannot conjure a
		// filesystem, and a full disk is worth trying again. Telling a person
		// inside the Epicenter app that they are not in it is the bug this split
		// exists to prevent.
		const { data } = await notebook();

		const absent = fakeHost();
		absent.unplug();
		expect(expectErr(await pullInto(absent, data)).name).toBe(
			'HostUnreachable',
		);

		const refusing = fakeHost();
		refusing.refuse(507);
		const refused = expectErr(await pullInto(refusing, data));
		expect(refused.name).toBe('HostRefused');
		if (refused.name !== 'HostRefused') throw new Error('unreachable');
		expect(refused.status).toBe(507);
		await data[Symbol.asyncDispose]();
	});
});

describe('pull refuses a folder holding unpushed edits', () => {
	/** Pull once, then edit the folder the way a person or an agent would. */
	async function pulledThenEdited(
		edit: (folder: Map<string, string>, noteId: string) => void,
	) {
		const host = fakeHost();
		const { data, noteId } = await notebook();
		expectOk(await pullInto(host, data));
		edit(host.folder, noteId);
		return { host, data, noteId };
	}

	test('a changed value names the field, and nothing is overwritten', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.set(
				`notes/${id}.md`,
				(folder.get(`notes/${id}.md`) as string).replace(
					'"Groceries"',
					'"Shopping"',
				),
			);
		});
		const refused = expectErr(await pullInto(host, data));
		expect(refused.name).toBe('WorkingCopyDirty');
		if (refused.name !== 'WorkingCopyDirty') throw new Error('unreachable');
		expect(refused.changes.rows).toEqual([
			{
				table: 'notes',
				rowId: noteId,
				values: ['title'],
				body: false,
				missing: false,
				added: false,
			},
		]);
		// The edit is still on disk. A refusal is not a repair (ADR-0281).
		expect(host.folder.get(`notes/${noteId}.md`)).toContain('"Shopping"');
		await data[Symbol.asyncDispose]();
	});

	test('a changed body is reported without being read', async () => {
		const { host, data } = await pulledThenEdited((folder, id) => {
			folder.set(
				`notes/${id}.md`,
				`${folder.get(`notes/${id}.md`) as string}and eggs\n`,
			);
		});
		const refused = expectErr(await pullInto(host, data));
		if (refused.name !== 'WorkingCopyDirty') throw new Error('unreachable');
		expect(refused.changes.rows[0]).toMatchObject({ body: true, values: [] });
		await data[Symbol.asyncDispose]();
	});

	test('a missing file and a new file are different facts', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.delete(`notes/${id}.md`);
			folder.set('notes/handwritten.md', '---\ntitle: "mine"\n---\n');
		});
		const refused = expectErr(await pullInto(host, data));
		if (refused.name !== 'WorkingCopyDirty') throw new Error('unreachable');
		expect(refused.changes.rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ rowId: noteId, missing: true }),
				expect.objectContaining({ rowId: 'handwritten', added: true }),
			]),
		);
		await data[Symbol.asyncDispose]();
	});

	test("a person's own file beside their notes is not an edit", async () => {
		const { host, data } = await pulledThenEdited((folder, _noteId) => {
			folder.set('README.md', 'notes about my notes');
			folder.set('AGENTS.md', 'how to edit these');
		});
		expectOk(await pullInto(host, data));
		await data[Symbol.asyncDispose]();
	});

	test('discarding is the way past, and it is the person saying so', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.set(`notes/${id}.md`, '---\ntitle: "gone"\n---\n');
		});
		const pulled = expectOk(await pullInto(host, data, { discardEdits: true }));
		expect(pulled.files).toBe(3);
		expect(host.folder.get(`notes/${noteId}.md`)).toContain('"Groceries"');
		await data[Symbol.asyncDispose]();
	});

	test('an edit to kv.json is reported, because it is never pushed', async () => {
		const { host, data } = await pulledThenEdited((folder) => {
			folder.set('kv.json', '{"theme":"dark"}');
		});
		const refused = expectErr(await pullInto(host, data));
		if (refused.name !== 'WorkingCopyDirty') throw new Error('unreachable');
		expect(refused.changes.kv).toBe(true);
		await data[Symbol.asyncDispose]();
	});
});

describe('workingCopyChanges', () => {
	test('a row file whose frame is gone counts as changed whole', async () => {
		// Nothing here guesses at a file it cannot parse. The base exists so that
		// a person decides, and a half-read file is exactly when that matters.
		const manifest: CheckoutManifest = {
			baseURL: CLOUD,
			principalId: 'alice',
			dataId: DATA_ID,
			generation: 1,
			pulledAt: '2026-09-02T10:00:00.000Z',
			rows: {
				'notes/abc': {
					values: { title: 'x' },
					bodyHash: await contentHash(''),
				},
			},
			kvHash: await contentHash('{}'),
		};
		const changes = await workingCopyChanges(
			manifest,
			new Map([
				['notes/abc.md', 'no frontmatter here'],
				['kv.json', '{}'],
			]),
		);
		expect(changes.rows).toEqual([
			{
				table: 'notes',
				rowId: 'abc',
				values: [],
				body: true,
				missing: false,
				added: false,
			},
		]);
		expect(changes.kv).toBe(false);
	});

	test('a value deleted from the frontmatter is an edit', async () => {
		const manifest: CheckoutManifest = {
			baseURL: CLOUD,
			principalId: 'alice',
			dataId: DATA_ID,
			generation: 1,
			pulledAt: '2026-09-02T10:00:00.000Z',
			rows: {
				'notes/abc': {
					values: { title: 'x', pinned: true },
					bodyHash: await contentHash(''),
				},
			},
			kvHash: '',
		};
		const changes = await workingCopyChanges(
			manifest,
			new Map([['notes/abc.md', '---\ntitle: "x"\n---\n']]),
		);
		expect(changes.rows[0]?.values).toEqual(['pinned']);
	});
});
