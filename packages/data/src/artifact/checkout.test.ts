/**
 * `pull` and the base it writes (ADR-0337).
 *
 * The host is a `fetch` here, because what these pin is the application's
 * half: that a pull hands over every file and a manifest describing exactly
 * those files, that it refuses a folder holding unpushed edits, and that
 * `planPush` calls an edit what it is. Whether the bytes reach a
 * filesystem is `apps/epicenter/src/checkout.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import {
	ContentError,
	defineData,
	defineTable,
	field,
	plainText,
} from '@epicenter/data/definition';
import type * as Y from '@y/y';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openMemory } from '../store/memory.js';
import {
	AGENTS_PATH,
	type CheckoutFile,
	type CheckoutManifest,
	checkoutLine,
	contentHash,
	diff,
	type FolderState,
	type KeepReason,
	MANIFEST_PATH,
	type PlanItem,
	type PushableData,
	type PushPlan,
	pull,
	push,
} from './checkout.js';

/** The one item of a plan of this kind, or a failure naming what was there. */
function only<TKind extends PlanItem['kind']>(
	plan: PushPlan,
	kind: TKind,
): Extract<PlanItem, { kind: TKind }> {
	const found = plan.filter((item) => item.kind === kind);
	if (found.length !== 1) {
		throw new Error(
			`expected one ${kind} item, found ${found.length} in ${JSON.stringify(plan)}`,
		);
	}
	return found[0] as Extract<PlanItem, { kind: TKind }>;
}

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

/** Which store these files are a working copy of, spelled once. */
const STORE: {
	dataId: string;
	generation: number;
	baseURL: string;
	principalId: string;
} = {
	dataId: DATA_ID,
	generation: 7,
	baseURL: CLOUD,
	principalId: 'alice',
};

/**
 * A store that states its own address, the way an opener stamps one
 * (ADR-0340).
 *
 * `openMemory` composes a store with no authority behind it, so these tests
 * put the four facts on it here. A test that wants a folder written from
 * somewhere else overrides one of them, which is the only way left to describe
 * a different store: the verbs read the address off the data.
 */
function addressed<TData>(
	data: TData,
	overrides: Partial<typeof STORE> = {},
): TData & typeof STORE {
	return Object.assign(
		Object.create(data as object),
		STORE,
		overrides,
	) as TData & typeof STORE;
}

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
	let writeRefusal: number | undefined;
	return {
		folder,
		unplug: () => {
			reachable = false;
		},
		refuse: (status: number) => {
			refusal = status;
		},
		/** Refuse only the write, so a read still answers. */
		refuseWrites: (status: number) => {
			writeRefusal = status;
		},
		fetch: (async (_input: string | URL, init?: RequestInit) => {
			if (!reachable) throw new Error('no host here');
			if (refusal !== undefined) {
				return new Response(null, { status: refusal });
			}
			if (init?.method === 'PUT') {
				if (writeRefusal !== undefined) {
					return new Response(null, { status: writeRefusal });
				}
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
	const data = addressed(await openMemory(definition));
	const note = data.tables.notes.create({ title: 'Groceries', pinned: false });
	const held = data.tables.notes.get(note.id);
	if (held === undefined) throw new Error('the row has no content');
	(held.content as Y.Type).insert(0, ['buy milk']);
	return { data, noteId: note.id };
}

function manifestOf(folder: ReadonlyMap<string, string>): CheckoutManifest {
	return JSON.parse(folder.get(MANIFEST_PATH) as string) as CheckoutManifest;
}

/** The plan inside a state that has a base, or a failure naming what was there. */
function planIn(state: Awaited<ReturnType<typeof diff>>): PushPlan {
	const found = expectOk(state);
	if (!found.base) throw new Error(`no base: ${JSON.stringify(found)}`);
	return found.plan;
}

/** What `diff` says about the folder right now. */
async function stateOf(
	host: ReturnType<typeof fakeHost>,
	data: Awaited<ReturnType<typeof notebook>>['data'],
) {
	return expectOk(await diff({ data, definition, fetch: host.fetch }));
}

/** The plan `diff` says, where the folder has a base to plan against. */
async function planOf(
	host: ReturnType<typeof fakeHost>,
	data: Awaited<ReturnType<typeof notebook>>['data'],
): Promise<PushPlan> {
	const state = await stateOf(host, data);
	if (!state.base) throw new Error(`no base: ${JSON.stringify(state)}`);
	return state.plan;
}

/**
 * Read the folder, then write over it, which is what a person does.
 *
 * Both steps, because a pull refuses a list it was not shown (ADR-0341), and a
 * test that skipped the reading would be testing a call nothing makes.
 */
async function pullInto(
	host: ReturnType<typeof fakeHost>,
	data: Awaited<ReturnType<typeof notebook>>['data'],
	state?: FolderState,
) {
	const read = await diff({ data, definition, fetch: host.fetch });
	return pull({
		data,
		definition,
		// A host that cannot be read has no state to approve, and the pull is
		// what reports that rather than the helper.
		state: state ?? read.data ?? { base: false, unwritten: [] },
		fetch: host.fetch,
		now: () => new Date('2026-09-02T10:00:00.000Z'),
	});
}

describe('pull fills the folder and writes the base', () => {
	test('every row is a file, and the manifest names exactly those files', async () => {
		const host = fakeHost();
		const { data, noteId } = await notebook();
		const pulled = expectOk(await pullInto(host, data));

		expect([...host.folder.keys()].sort()).toEqual([
			MANIFEST_PATH,
			AGENTS_PATH,
			'kv.json',
			`notes/${noteId}.md`,
		]);
		expect(pulled.files).toBe(4);

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

	test("a first pull names somebody's own row-shaped files before it writes", async () => {
		// The folder holds `drafts/ideas.md` and no manifest, so nothing wrote
		// down what these files are. Filling it removes that file, which is what
		// a person has to be shown first: one fact about the folder rather than
		// one item per file, because the answer to all of them is the same.
		const host = fakeHost([
			{ path: 'drafts/ideas.md', contents: '---\ntitle: "mine"\n---\n' },
			{ path: 'README.md', contents: 'not a row, not touched' },
		]);
		const { data } = await notebook();
		expect(await stateOf(host, data)).toEqual({
			base: false,
			unwritten: ['drafts/ideas.md'],
		});
		// A person's own file that is not row-shaped is not the folder's to
		// name, and the host never hands it over to be swept.
		expect(host.folder.has('README.md')).toBe(true);
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

		expect(await stateOf(host, data)).toMatchObject({ base: false });
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

		const state = await stateOf(host, data);
		expect(state.base).toBe(false);
		// Not a diff against Alice's base: a manifest naming another account is
		// no base at all, so every file in the folder is shown whole.
		if (state.base) throw new Error('unreachable');
		expect(state.unwritten.length).toBeGreaterThan(0);
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

describe('a pull shows what it writes over, and a person says yes', () => {
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
		expect(await planOf(host, data)).toEqual([
			{
				kind: 'value',
				path: `notes/${noteId}.md`,
				table: 'notes',
				rowId: noteId,
				name: 'title',
				store: 'Groceries',
				file: 'Shopping',
				storeChanged: false,
			},
		]);
		// The edit is still on disk. A refusal is not a repair (ADR-0281).
		expect(host.folder.get(`notes/${noteId}.md`)).toContain('"Shopping"');
		await data[Symbol.asyncDispose]();
	});

	test('a changed body is unpushed work like any other', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.set(
				`notes/${id}.md`,
				`${folder.get(`notes/${id}.md`) as string}and eggs\n`,
			);
		});
		const plan = await planOf(host, data);
		expect(only(plan, 'body')).toEqual({
			kind: 'body',
			path: `notes/${noteId}.md`,
			table: 'notes',
			rowId: noteId,
			storeChanged: false,
			fileHash: expect.any(String) as unknown as string,
		});
		await data[Symbol.asyncDispose]();
	});

	test('a missing file and a new file are different facts', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.delete(`notes/${id}.md`);
			folder.set('notes/handwritten.md', '---\ntitle: "mine"\n---\n');
		});
		const plan = await planOf(host, data);
		expect(only(plan, 'deletion')).toEqual({
			kind: 'deletion',
			path: `notes/${noteId}.md`,
			table: 'notes',
			rowId: noteId,
		});
		// A file nobody pulled is a row waiting to be made, which is what stops
		// one stray file wedging both directions.
		expect(only(plan, 'admission')).toEqual({
			kind: 'admission',
			path: 'notes/handwritten.md',
			table: 'notes',
			fileHash: expect.any(String) as unknown as string,
		});
		await data[Symbol.asyncDispose]();
	});

	test("a person's own file beside their notes is not an edit", async () => {
		const { host, data } = await pulledThenEdited((folder) => {
			folder.set('README.md', 'notes about my notes');
			folder.set('drafts/half-an-idea.txt', 'not a row');
		});
		expectOk(await pullInto(host, data));
		await data[Symbol.asyncDispose]();
	});

	test('confirming the list IS the discard', async () => {
		// A pull writes over everything in the list, and a person who read the
		// list said so. There is no second gesture (ADR-0341).
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.set(`notes/${id}.md`, '---\ntitle: "gone"\n---\n');
		});
		const state = await stateOf(host, data);
		expect(state).toMatchObject({ base: true });

		const pulled = expectOk(await pullInto(host, data, state));
		expect(pulled.files).toBe(4);
		expect(host.folder.get(`notes/${noteId}.md`)).toContain('"Groceries"');
		await data[Symbol.asyncDispose]();
	});

	test('a pull refuses a folder that moved after the person read it', async () => {
		// The other half of the guard `PlanStale` is for a push: a pull writes
		// over everything in the list it was shown, so applying a list that
		// moved would write over work nobody saw.
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.set(`notes/${id}.md`, '---\ntitle: "one"\n---\n');
		});
		const state = await stateOf(host, data);
		host.folder.set(`notes/${noteId}.md`, '---\ntitle: "two"\n---\n');

		const refused = expectErr(await pullInto(host, data, state));
		expect(refused.name).toBe('FolderChanged');
		expect(host.folder.get(`notes/${noteId}.md`)).toContain('"two"');
		await data[Symbol.asyncDispose]();
	});

	test('an edit to kv.json is reported, because it is never pushed', async () => {
		const { host, data } = await pulledThenEdited((folder) => {
			folder.set('kv.json', '{"theme":"dark"}');
		});
		expect(await planOf(host, data)).toEqual([
			{ kind: 'kept', path: 'kv.json', reason: 'kv-changed' },
		]);
		await data[Symbol.asyncDispose]();
	});
});

describe('diff plans what push would do (ADR-0337)', () => {
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

	/** Rewrite one field in a row file the way a hand editor would. */
	function setField(
		folder: Map<string, string>,
		path: string,
		line: string,
		next: string,
	) {
		folder.set(path, (folder.get(path) as string).replace(line, next));
	}

	test('a value the person changed and the store did not is applied', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			setField(folder, `notes/${id}.md`, '"Groceries"', '"Shopping"');
		});
		const plan = await planOf(host, data);
		expect(plan).toEqual([
			{
				kind: 'value',
				path: `notes/${noteId}.md`,
				table: 'notes',
				rowId: noteId,
				name: 'title',
				store: 'Groceries',
				file: 'Shopping',
				storeChanged: false,
			},
		]);
		await data[Symbol.asyncDispose]();
	});

	test('a value the person did not touch leaves the store alone', async () => {
		// `mine == base`, so the store's value stands however far it has moved.
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			setField(folder, `notes/${id}.md`, 'pinned: false', 'pinned: true');
		});
		data.tables.notes.update(noteId, { title: 'Moved on' });
		const plan = await planOf(host, data);
		expect(only(plan, 'value')).toMatchObject({
			name: 'pinned',
			store: false,
			file: true,
		});
		await data[Symbol.asyncDispose]();
	});

	test('the same edit on both sides is already converged', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			setField(folder, `notes/${id}.md`, '"Groceries"', '"Shopping"');
		});
		data.tables.notes.update(noteId, { title: 'Shopping' });
		const plan = await planOf(host, data);
		expect(plan).toEqual([]);
		await data[Symbol.asyncDispose]();
	});

	test('all three differing is a value line saying the store moved too', async () => {
		// The folder wins (ADR-0338), and what a person is owed is being told
		// the store's value is going. That is `storeChanged`, and it is the same
		// item kind as any other value: a per-item question here was answered
		// `store` by clicking through it.
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			setField(folder, `notes/${id}.md`, '"Groceries"', '"Q3 plan"');
		});
		data.tables.notes.update(noteId, { title: 'Q3 planning' });
		const plan = await planOf(host, data);
		expect(only(plan, 'value')).toMatchObject({
			name: 'title',
			file: 'Q3 plan',
			store: 'Q3 planning',
			storeChanged: true,
		});

		expectOk(
			await push({
				data,
				definition,
				plan,
				fetch: host.fetch,
			}),
		);
		expect(data.tables.notes.get(noteId)?.title).toBe('Q3 plan');
		await data[Symbol.asyncDispose]();
	});

	test('a body edit is an item beside the values, not instead of them', async () => {
		// It used to refuse the row outright, so one edited paragraph hid every
		// value edit in the same file from the person deciding.
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			const path = `notes/${id}.md`;
			folder.set(
				path,
				`${(folder.get(path) as string).replace('"Groceries"', '"Shopping"')}and eggs\n`,
			);
		});
		const plan = await planOf(host, data);
		expect(only(plan, 'body')).toMatchObject({
			path: `notes/${noteId}.md`,
			storeChanged: false,
		});
		expect(only(plan, 'value')).toMatchObject({ name: 'title' });
		await data[Symbol.asyncDispose]();
	});

	test('a body that moved on both sides says so before it is answered', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.set(
				`notes/${id}.md`,
				`${folder.get(`notes/${id}.md`) as string}and eggs\n`,
			);
		});
		const held = data.tables.notes.get(noteId);
		(held?.content as Y.Type).insert(0, ['typed here too. ']);
		const plan = await planOf(host, data);
		expect(only(plan, 'body').storeChanged).toBe(true);
		await data[Symbol.asyncDispose]();
	});

	test('a body the codec cannot read is a file the send rewrites', async () => {
		// Checked with `decode`, which validates the text `rewrite` would apply,
		// so a person never reads a plan its own push then refuses.
		const refusing = defineData({
			id: 'so.epicenter.honeycrisp',
			kv: { theme: field.string() },
			tables: {
				notes: defineTable({
					title: field.string(),
					pinned: field.boolean(),
					content: {
						encode: (node) => node.toString(),
						decode: () => ContentError.Unreadable({ reason: 'not a body' }),
						rewrite: () => Ok(undefined),
					},
				}),
			},
		});
		const host = fakeHost();
		const data = addressed(await openMemory(refusing));
		const note = data.tables.notes.create({ title: 'x', pinned: false });
		expectOk(
			await pull({
				data,
				definition: refusing,
				state: { base: false, unwritten: [] },
				fetch: host.fetch,
			}),
		);
		host.folder.set(
			`notes/${note.id}.md`,
			`${host.folder.get(`notes/${note.id}.md`) as string}\nprose\n`,
		);
		const plan = planIn(
			await diff({
				data,
				definition: refusing,
				fetch: host.fetch,
			}),
		);
		expect(only(plan, 'kept').reason).toBe('body-unreadable');
		await data[Symbol.asyncDispose]();
	});

	test('a note deleted in the application does not make the folder dirty', async () => {
		// Nobody touched the folder. Before the file was compared to its base,
		// the store was consulted first, the row was gone, and a file the person
		// had never opened came back as a change, so the next pull refused
		// with work they were about to lose that they had never done.
		const host = fakeHost();
		const { data, noteId } = await notebook();
		expectOk(await pullInto(host, data));
		data.tables.notes.delete(noteId);

		expect(await planOf(host, data)).toEqual([]);
		// And the pull it was blocking goes through.
		expectOk(await pullInto(host, data));
		expect(host.folder.has(`notes/${noteId}.md`)).toBe(false);
		await data[Symbol.asyncDispose]();
	});

	test('a file the person edited whose note is gone comes back as a note', async () => {
		// The other side of the same gate: they DID touch it, and there is no
		// row to carry it to. The folder wins (ADR-0341), so the file is one
		// nobody pulled, and it is admitted under a new id.
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			setField(folder, `notes/${id}.md`, '"Groceries"', '"Shopping"');
		});
		data.tables.notes.delete(noteId);

		expect(only(await planOf(host, data), 'admission')).toMatchObject({
			path: `notes/${noteId}.md`,
			table: 'notes',
			replaces: noteId,
		});
		await data[Symbol.asyncDispose]();
	});

	test('the note it comes back as is a new one, and the old id is gone', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			setField(folder, `notes/${id}.md`, '"Groceries"', '"Shopping"');
		});
		data.tables.notes.delete(noteId);
		const plan = await planOf(host, data);

		const done = expectOk(
			await push({ data, definition, plan, fetch: host.fetch }),
		);
		const minted = done.admitted[0]?.rowId as string;
		expect(minted).not.toBe(noteId);
		expect(data.tables.notes.get(minted)?.title).toBe('Shopping');
		expect(data.tables.notes.get(noteId)).toBeUndefined();
		// The file is at the new id, and the name it had is swept.
		expect(host.folder.has(`notes/${noteId}.md`)).toBe(false);
		expect(host.folder.get(`notes/${minted}.md`)).toContain('"Shopping"');
		await data[Symbol.asyncDispose]();
	});

	test('a deletion deletes and a new file is admitted', async () => {
		// The manifest is what tells them apart: a file it named and the folder
		// no longer holds is somebody deleting a note, and one it never named is
		// a row waiting to be made (ADR-0338).
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.delete(`notes/${id}.md`);
			folder.set(
				'notes/handwritten.md',
				'---\ntitle: "mine"\npinned: false\n---\n\nwritten by hand\n',
			);
		});
		const plan = await planOf(host, data);
		expect(only(plan, 'deletion')).toEqual({
			kind: 'deletion',
			path: `notes/${noteId}.md`,
			table: 'notes',
			rowId: noteId,
		});
		expect(only(plan, 'admission')).toEqual({
			kind: 'admission',
			path: 'notes/handwritten.md',
			table: 'notes',
			fileHash: expect.any(String) as unknown as string,
		});
		await data[Symbol.asyncDispose]();
	});

	test('a new file missing a value is still a row, and an undeclared name rides along', async () => {
		// Nothing is validated on the way in (ADR-0338). A definition declares no
		// defaults (ADR-0255), so this mints a row this release reads as
		// nonconforming, which is a state the store already has a word, a
		// surface, and a record for (ADR-0125): the note list shows it, and the
		// repair is the file.
		const { host, data } = await pulledThenEdited((folder) => {
			folder.set(
				'notes/handwritten.md',
				'---\ntitle: "mine"\ncolour: "red"\n---\n',
			);
		});
		const plan = await planOf(host, data);
		expect(plan).toEqual([
			{
				kind: 'admission',
				path: 'notes/handwritten.md',
				table: 'notes',
				fileHash: expect.any(String) as unknown as string,
			},
		]);
		await data[Symbol.asyncDispose]();
	});

	test('a deleted frontmatter line is null, and applies as an ordinary value edit', async () => {
		// `frontmatter.ts` writes `null` for an absent value and for `null`
		// alike, so the file format already decided this: there is no unset to
		// tell apart from a value (ADR-0338).
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.set(
				`notes/${id}.md`,
				`---\ntitle: "Groceries"\n---\n\nbuy milk\n`,
			);
		});
		const plan = await planOf(host, data);
		expect(plan).toEqual([
			{
				kind: 'value',
				path: `notes/${noteId}.md`,
				table: 'notes',
				rowId: noteId,
				name: 'pinned',
				store: false,
				file: null,
				storeChanged: false,
			},
		]);
		await data[Symbol.asyncDispose]();
	});
});

describe('push sends the values back and re-renders', () => {
	/** Pull, edit one field in the folder, and read the plan a person confirms. */
	async function edited(replace: [string, string]) {
		const host = fakeHost();
		const { data, noteId } = await notebook();
		expectOk(await pullInto(host, data));
		host.folder.set(
			`notes/${noteId}.md`,
			(host.folder.get(`notes/${noteId}.md`) as string).replace(...replace),
		);
		return { host, data, noteId };
	}

	const sendBack = (
		host: ReturnType<typeof fakeHost>,
		data: PushableData & typeof STORE,
		plan: PushPlan,
	) => push({ data, definition, plan, fetch: host.fetch });

	test('an applied value reaches the store, and its file is rewritten', async () => {
		const { host, data, noteId } = await edited(['"Groceries"', '"Shopping"']);
		const plan = await planOf(host, data);

		const pushed = expectOk(await sendBack(host, data, plan));
		expect(pushed).toEqual({
			rows: 1,
			values: 1,
			bodies: 0,
			deleted: 0,
			admitted: [],
		});
		expect(data.tables.notes.get(noteId)?.title).toBe('Shopping');

		// The file this push touched carries the new value, and the folder is
		// clean, so a second pull asks nobody anything.
		expect(host.folder.get(`notes/${noteId}.md`)).toContain('"Shopping"');
		expect(await planOf(host, data)).toEqual([]);
		// The manifest still says when the folder was PULLED. A push is not a
		// re-render, so nothing about the folder got more current except the
		// files it wrote (ADR-0341).
		expect(manifestOf(host.folder).pulledAt).toBe('2026-09-02T10:00:00.000Z');
		expectOk(await pullInto(host, data));
		await data[Symbol.asyncDispose]();
	});

	test('a value the store also moved is applied, and the folder still wins', async () => {
		// The one place a button was ever genuinely cheaper, and it was still a
		// hand merge either way (ADR-0338). The overview says the store moved;
		// the push writes the file's value.
		const { host, data, noteId } = await edited(['"Groceries"', '"Q3 plan"']);
		data.tables.notes.update(noteId, { title: 'Q3 planning' });
		const plan = await planOf(host, data);

		const pushed = expectOk(await sendBack(host, data, plan));
		expect(pushed).toEqual({
			rows: 1,
			values: 1,
			bodies: 0,
			deleted: 0,
			admitted: [],
		});
		expect(data.tables.notes.get(noteId)?.title).toBe('Q3 plan');
		expect(host.folder.get(`notes/${noteId}.md`)).toContain('"Q3 plan"');
		await data[Symbol.asyncDispose]();
	});

	test('a push whose plan stopped being true applies nothing at all', async () => {
		// Half a push is a folder that matches nothing, and the re-render at the
		// end would overwrite whatever it left behind.
		const { host, data, noteId } = await edited(['"Groceries"', '"Shopping"']);
		const plan = await planOf(host, data);
		host.folder.set(
			`notes/${noteId}.md`,
			`${host.folder.get(`notes/${noteId}.md`) as string}and eggs\n`,
		);

		const refused = expectErr(await sendBack(host, data, plan));
		expect(refused.name).toBe('FolderChanged');
		expect(data.tables.notes.get(noteId)?.title).toBe('Groceries');
		await data[Symbol.asyncDispose]();
	});

	test('a body edited again after the overview is a different plan', async () => {
		// The guard is that the list applied is the list somebody read, and an
		// agent may still be working while the overview is open (ADR-0330). A
		// body carries no text, so without a hash on the item this plan is
		// byte-identical and the push rewrites the note from text nobody read.
		const { host, data, noteId } = await edited(['buy milk', 'buy bread']);
		const plan = await planOf(host, data);
		host.folder.set(
			`notes/${noteId}.md`,
			(host.folder.get(`notes/${noteId}.md`) as string).replace(
				'buy bread',
				'buy something else entirely',
			),
		);

		const refused = expectErr(await sendBack(host, data, plan));
		expect(refused.name).toBe('FolderChanged');
		expect(
			(data.rowFile('notes', noteId)?.content as Y.Type).toString(),
		).toContain('buy milk');
		await data[Symbol.asyncDispose]();
	});

	test('a new file edited again after the overview is a different plan', async () => {
		// Same rule for the other item whose contents are not in the plan:
		// `push` re-reads the file to build the row.
		const { host, data } = await edited(['buy milk', 'buy milk']);
		host.folder.set(
			'notes/q3-plan.md',
			'---\ntitle: "Q3 plan"\npinned: true\n---\n\nship the thing\n',
		);
		const plan = await planOf(host, data);
		host.folder.set(
			'notes/q3-plan.md',
			'---\ntitle: "Q3 plan"\npinned: true\n---\n\nship something else\n',
		);

		const refused = expectErr(await sendBack(host, data, plan));
		expect(refused.name).toBe('FolderChanged');
		expect(data.tables.notes.ids()).toHaveLength(1);
		await data[Symbol.asyncDispose]();
	});

	test('a file the push could not read is left exactly as it was', async () => {
		// A push writes only what it touched (ADR-0341), so the file is not
		// rewritten and nothing typed into it is destroyed. Its manifest entry is
		// carried forward, which is what keeps the next push from reading a
		// value the STORE changed as an edit this person made.
		const { host, data, noteId } = await edited(['"Groceries"', '"Shopping"']);
		const broken = '---\ntitle: "Shopping"\n\nthree paragraphs I typed\n';
		host.folder.set(`notes/${noteId}.md`, broken);
		const before = manifestOf(host.folder).rows[`notes/${noteId}`];
		const plan = await planOf(host, data);
		expect(only(plan, 'kept').reason).toBe('unreadable');

		expectOk(await sendBack(host, data, plan));
		expect(host.folder.get(`notes/${noteId}.md`)).toBe(broken);
		expect(manifestOf(host.folder).rows[`notes/${noteId}`]).toEqual(
			before as never,
		);
		// And it says so again at the next push, until the frame is fixed.
		expect(only(await planOf(host, data), 'kept').reason).toBe('unreadable');
		await data[Symbol.asyncDispose]();
	});

	test('a file this push did not touch is sent back as it was', async () => {
		// The folder does not update itself. A note another device changed
		// reaches this folder at the next pull, not under the person's hands
		// while they push something else.
		const host = fakeHost();
		const { data, noteId } = await notebook();
		const other = data.tables.notes.create({
			title: 'Untouched',
			pinned: false,
		});
		expectOk(await pullInto(host, data));
		host.folder.set(
			`notes/${noteId}.md`,
			(host.folder.get(`notes/${noteId}.md`) as string).replace(
				'"Groceries"',
				'"Shopping"',
			),
		);
		// The other note moves in the application while the folder sits there.
		data.tables.notes.update(other.id, { title: 'Changed elsewhere' });
		const plan = await planOf(host, data);

		expectOk(await sendBack(host, data, plan));
		expect(host.folder.get(`notes/${other.id}.md`)).toContain('"Untouched"');
		await data[Symbol.asyncDispose]();
	});

	test('a plan that stopped being true is refused, and says what is', async () => {
		// Between the overview and the click the store moved, so the list about
		// to be applied is not the list somebody read. The refusal carries the
		// plan that is true now.
		const { host, data, noteId } = await edited(['"Groceries"', '"Shopping"']);
		const plan = await planOf(host, data);
		data.tables.notes.update(noteId, { title: 'Moved underneath' });

		const refused = expectErr(await sendBack(host, data, plan));
		expect(refused.name).toBe('FolderChanged');
		if (refused.name !== 'FolderChanged') throw new Error('unreachable');
		// The refusal carries what is TRUE NOW, not the list they read.
		expect(
			only(refused.state.base ? refused.state.plan : [], 'value'),
		).toMatchObject({
			name: 'title',
			file: 'Shopping',
			store: 'Moved underneath',
			storeChanged: true,
		});
		expect(data.tables.notes.get(noteId)?.title).toBe('Moved underneath');
		await data[Symbol.asyncDispose]();
	});

	test('a value that does not fit its field is written, and the row stops reading', async () => {
		// The folder is not a stricter door than `update`, which validates
		// nothing (ADR-0125, ADR-0240, ADR-0338). `pinned: yes` reads as the
		// string "yes", goes in as one, and the row is then one this release
		// cannot read: the store holds it and the note list says so.
		const { host, data, noteId } = await edited([
			'pinned: false',
			'pinned: yes',
		]);
		const plan = await planOf(host, data);
		expect(plan).toEqual([
			{
				kind: 'value',
				path: `notes/${noteId}.md`,
				table: 'notes',
				rowId: noteId,
				name: 'pinned',
				store: false,
				file: 'yes',
				storeChanged: false,
			},
		]);
		expectOk(await sendBack(host, data, plan));
		expect(data.tables.notes.get(noteId)).toBeUndefined();
		expect(data.tables.notes.nonconforming[0]?.raw.pinned).toBe('yes');
		// And the folder was rewritten from the row, so the line survives the
		// round trip rather than being tidied away.
		expect(host.folder.get(`notes/${noteId}.md`)).toContain('pinned: "yes"');
		await data[Symbol.asyncDispose]();
	});

	test('a name nothing declares goes in, and a name the store reserves goes nowhere', async () => {
		// An undeclared name rides through a write untouched (ADR-0240), so it
		// is an ordinary value. `id` and `content` are not values at all
		// (ADR-0309) and writing either THROWS, so they are filtered off the
		// file the way `readRow` filters them off a row.
		const { host, data, noteId } = await edited([
			'pinned: false',
			'pinned: false\nid: "forged"\ncontent: "text"\ntitel: "typo"',
		]);
		const plan = await planOf(host, data);
		expect(plan).toEqual([
			{
				kind: 'value',
				path: `notes/${noteId}.md`,
				table: 'notes',
				rowId: noteId,
				name: 'titel',
				store: undefined,
				file: 'typo',
				storeChanged: false,
			},
		]);
		expectOk(await sendBack(host, data, plan));
		expect(data.tables.notes.get(noteId)?.id).toBe(noteId);
		expect(host.folder.get(`notes/${noteId}.md`)).toContain('titel: "typo"');
		await data[Symbol.asyncDispose]();
	});

	test('an answered body edit rewrites the note in the node it already has', async () => {
		// The identity claim lives in the codec's own test; what this pins is
		// that a push reaches the live node rather than replacing the row's.
		const { host, data, noteId } = await edited(['buy milk', 'buy milk']);
		const before = data.tables.notes.get(noteId)?.content;
		host.folder.set(
			`notes/${noteId}.md`,
			`${host.folder.get(`notes/${noteId}.md`) as string}and eggs\n`,
		);
		const plan = await planOf(host, data);

		const pushed = expectOk(await sendBack(host, data, plan));
		expect(pushed.bodies).toBe(1);
		expect(data.tables.notes.get(noteId)?.content).toBe(before);
		expect((before as Y.Type).toString()).toContain('and eggs');
		expectOk(await pullInto(host, data));
		await data[Symbol.asyncDispose]();
	});

	test('an edited body is rewritten into the node the row already holds', async () => {
		// The folder wins the text too, and `rewrite` is what keeps an editor
		// bound to this very note bound after (ADR-0338).
		const { host, data, noteId } = await edited(['buy milk', 'buy milk']);
		host.folder.set(
			`notes/${noteId}.md`,
			`${host.folder.get(`notes/${noteId}.md`) as string}and eggs\n`,
		);
		const plan = await planOf(host, data);

		const pushed = expectOk(await sendBack(host, data, plan));
		expect(pushed.bodies).toBe(1);
		expect(
			(data.rowFile('notes', noteId)?.content as Y.Type).toString(),
		).toContain('and eggs');
		expect(host.folder.get(`notes/${noteId}.md`)).toContain('and eggs');
		await data[Symbol.asyncDispose]();
	});

	test('a hand-written file becomes a row, and the re-render renames it', async () => {
		// A row id is minted and never chosen, so the rename is not avoidable.
		// What makes it not rude is that the plan named the file first.
		const { host, data } = await edited(['buy milk', 'buy milk']);
		host.folder.set(
			'notes/q3-plan.md',
			'---\ntitle: "Q3 plan"\npinned: true\n---\n\nship the thing\n',
		);
		const plan = await planOf(host, data);

		const pushed = expectOk(await sendBack(host, data, plan));
		expect(pushed.admitted).toEqual([
			{
				path: 'notes/q3-plan.md',
				table: 'notes',
				rowId: expect.any(String) as unknown as string,
			},
		]);
		const minted = pushed.admitted[0]?.rowId as string;
		const made = data.tables.notes.get(minted);
		expect(made?.title).toBe('Q3 plan');
		expect(made?.pinned).toBe(true);
		// The body came with it, through the same codec that writes it out.
		expect((made?.content as Y.Type).toString()).toContain('ship the thing');

		// The name the agent chose is gone, and the row is at its id.
		expect(host.folder.has('notes/q3-plan.md')).toBe(false);
		expect(host.folder.get(`notes/${minted}.md`)).toContain('"Q3 plan"');
		// And the folder is clean, which is what a round trip has to end at.
		expectOk(await pullInto(host, data));
		await data[Symbol.asyncDispose]();
	});

	test("an agent's stray file becomes a note rather than wedging the send", async () => {
		// The wedge ADR-0337 shipped and ADR-0338 removed: one file nobody
		// pulled used to stop everything until somebody opened Finder. A person
		// who wants neither cancels and renames it out of the way.
		const { host, data } = await edited(['buy milk', 'buy milk']);
		host.folder.set(
			'notes/scratch.md',
			'---\ntitle: "scratch"\npinned: false\n---\n',
		);
		const plan = await planOf(host, data);

		const pushed = expectOk(await sendBack(host, data, plan));
		expect(pushed.admitted).toHaveLength(1);
		expect(data.tables.notes.ids()).toHaveLength(2);
		expect(host.folder.has('notes/scratch.md')).toBe(false);
		await data[Symbol.asyncDispose]();
	});

	test('a codec that throws is a file the send rewrites, not a rejected plan', async () => {
		// A codec is application code run over a file somebody hand-edited, and
		// a plan that let a throw escape would make `diff` REJECT on the one
		// surface a person has to be able to look at.
		const exploding = defineData({
			id: 'so.epicenter.honeycrisp',
			kv: { theme: field.string() },
			tables: {
				notes: defineTable({
					title: field.string(),
					pinned: field.boolean(),
					content: {
						encode: (node) => node.toString(),
						decode: () => {
							throw new Error('the codec exploded');
						},
						rewrite: () => Ok(undefined),
					},
				}),
			},
		});
		const host = fakeHost();
		const data = addressed(await openMemory(exploding));
		const note = data.tables.notes.create({ title: 'x', pinned: false });
		expectOk(
			await pull({
				data,
				definition: exploding,
				state: { base: false, unwritten: [] },
				fetch: host.fetch,
			}),
		);
		host.folder.set(
			`notes/${note.id}.md`,
			`${host.folder.get(`notes/${note.id}.md`) as string}\nprose\n`,
		);
		const plan = planIn(
			await diff({
				data,
				definition: exploding,
				fetch: host.fetch,
			}),
		);
		expect(only(plan, 'kept').reason).toBe('body-unreadable');
		await data[Symbol.asyncDispose]();
	});

	test('a body the codec refuses does not take the values beside it', async () => {
		// A discard is not always the whole file. The body is one region, and
		// the values in the same frontmatter are ordinary values: everything the
		// folder can express lands, and only what cannot be read is written
		// over (ADR-0338).
		const exploding = defineData({
			id: 'so.epicenter.honeycrisp',
			kv: { theme: field.string() },
			tables: {
				notes: defineTable({
					title: field.string(),
					pinned: field.boolean(),
					content: {
						encode: (node) => node.toString(),
						decode: () => {
							throw new Error('the codec exploded');
						},
						rewrite: () => Ok(undefined),
					},
				}),
			},
		});
		const host = fakeHost();
		const data = addressed(await openMemory(exploding));
		const note = data.tables.notes.create({ title: 'x', pinned: false });
		expectOk(
			await pull({
				data,
				definition: exploding,
				state: { base: false, unwritten: [] },
				fetch: host.fetch,
			}),
		);
		// One file, two edits: a value it can carry and a body it cannot.
		host.folder.set(
			`notes/${note.id}.md`,
			'---\ntitle: "changed by hand"\npinned: false\n---\n\nnew text\n',
		);
		const plan = planIn(
			await diff({ data, definition: exploding, fetch: host.fetch }),
		);
		expect(only(plan, 'kept').reason).toBe('body-unreadable');
		expect(only(plan, 'value')).toMatchObject({
			name: 'title',
			file: 'changed by hand',
		});

		expectOk(
			await push({ data, definition: exploding, plan, fetch: host.fetch }),
		);
		expect(data.tables.notes.get(note.id)?.title).toBe('changed by hand');
		// And the file is LEFT ALONE, because one region of it could not be
		// read (ADR-0341). Re-rendering it here would destroy the text the
		// person typed in the same act that carried their value.
		expect(host.folder.get(`notes/${note.id}.md`)).toContain('new text');
		// And the entry carried forward records the value that LANDED, not the
		// one the folder was pulled at. A base that still said `x` would read
		// this file as an edit at the next push and write it over whatever
		// another device had done since.
		const manifest = manifestOf(host.folder);
		expect(manifest.rows[`notes/${note.id}`]?.values.title).toBe(
			'changed by hand',
		);
		await data[Symbol.asyncDispose]();
	});

	test('a plan is the same plan however the host orders the folder', async () => {
		// `push` compares the plan a person confirmed against one it computes
		// again, so a different ORDER would read as a different plan and refuse
		// forever. Two of the three sources are already deterministic; the third
		// is a directory listing.
		const { host, data } = await edited(['"Groceries"', '"Shopping"']);
		host.folder.set(
			'notes/a-scratch.md',
			'---\ntitle: "a"\npinned: false\n---\n',
		);
		host.folder.set(
			'notes/z-scratch.md',
			'---\ntitle: "z"\npinned: false\n---\n',
		);
		const plan = await planOf(host, data);

		// Hand the same files back in the opposite order.
		const reversed = new Map([...host.folder].reverse());
		host.folder.clear();
		for (const [path, contents] of reversed) host.folder.set(path, contents);
		expect(await planOf(host, data)).toEqual(plan);
		await data[Symbol.asyncDispose]();
	});

	test('a folder pulled from another generation is no base at all', async () => {
		// A generation is a whole database (ADR-0281), so a folder written from
		// the one before this describes rows that are not these rows, and
		// reading it as a base would call every one of them a deletion.
		const { host, data } = await edited(['"Groceries"', '"Shopping"']);
		// The same folder, read by a store that is the next generation. Nothing
		// can address the folder at a generation any more, so this is a store
		// standing where the newer one would.
		const state = expectOk(
			await diff({
				data: addressed(data, { generation: STORE.generation + 1 }),
				definition,
				fetch: host.fetch,
			}),
		);
		expect(state.base).toBe(false);
		if (state.base) throw new Error('unreachable');
		expect(state.unwritten.length).toBeGreaterThan(0);
		await data[Symbol.asyncDispose]();
	});

	test('a deleted file deletes the note, and nothing is asked about it', async () => {
		// Trashing a note through the folder is setting `deletedAt`, which is an
		// ordinary value edit. Removing the file is the other gesture, and it
		// skips Recently Deleted (ADR-0338).
		const { host, data, noteId } = await edited(['"Groceries"', '"Shopping"']);
		host.folder.delete(`notes/${noteId}.md`);
		const plan = await planOf(host, data);
		expect(only(plan, 'deletion').rowId).toBe(noteId);

		const pushed = expectOk(await sendBack(host, data, plan));
		expect(pushed.deleted).toBe(1);
		expect(data.tables.notes.get(noteId)).toBeUndefined();
		// The re-render writes the folder from the store, so the file stays gone
		// rather than coming back at the next pull.
		expect(host.folder.has(`notes/${noteId}.md`)).toBe(false);
		await data[Symbol.asyncDispose]();
	});

	test('a note deleted here and its file deleted there is nothing to say', async () => {
		// Both sides already agree, so the plan is empty rather than carrying a
		// deletion that would delete an address holding no row.
		const { host, data, noteId } = await edited(['"Groceries"', '"Shopping"']);
		host.folder.delete(`notes/${noteId}.md`);
		data.tables.notes.delete(noteId);
		expect(await planOf(host, data)).toEqual([]);
		await data[Symbol.asyncDispose]();
	});

	test('the values land and the folder cannot be rewritten, said as its own outcome', async () => {
		// The push WORKED. Reporting the write failure alone would send a person
		// looking for work that already landed.
		const { host, data, noteId } = await edited(['"Groceries"', '"Shopping"']);
		const plan = await planOf(host, data);
		host.refuseWrites(507);

		const stale = expectErr(await sendBack(host, data, plan));
		expect(stale.name).toBe('FolderStale');
		if (stale.name !== 'FolderStale') throw new Error('unreachable');
		expect(stale.values).toBe(1);
		expect(data.tables.notes.get(noteId)?.title).toBe('Shopping');
		await data[Symbol.asyncDispose]();
	});
});

describe('the folder explains itself (ADR-0337, ADR-0330)', () => {
	/**
	 * A definition with the shapes the generator has to render: a nullable
	 * field, a reference, and a table whose rows have no text.
	 */
	const shapes = defineData({
		id: 'so.epicenter.shapes',
		kv: {},
		tables: {
			notes: defineTable({
				title: field.string(),
				folderId: field.nullable(field.reference('folders')),
				content: plainText(),
			}),
			folders: defineTable({ name: field.string(), content: plainText() }),
		},
	});

	async function agentsFor(
		data: PushableData & typeof STORE,
		of: typeof definition | typeof shapes = definition,
	) {
		const host = fakeHost();
		expectOk(
			await pull({
				data,
				definition: of,
				state: { base: false, unwritten: [] },
				fetch: host.fetch,
			}),
		);
		return { host, agents: host.folder.get(AGENTS_PATH) as string };
	}

	test('every table and field the definition declares is in it', async () => {
		// Derived from the definition rather than compared to a fixture, so the
		// test says the rule (everything that exists is named) instead of
		// pinning today's markdown.
		const data = addressed(await openMemory(shapes), { dataId: shapes.id });
		const { agents } = await agentsFor(
			data as unknown as PushableData & typeof STORE,
			shapes,
		);
		for (const [name, table] of Object.entries(shapes.tables)) {
			expect(agents).toContain(`### ${name}/`);
			for (const fieldName of Object.keys(table)) {
				if (fieldName === 'content') continue;
				expect(agents).toContain(`\`${fieldName}\``);
			}
		}
		// A nullable reference says both facts, because an agent writing one has
		// to know it may be null and what it points at.
		expect(agents).toContain('| `folderId` | reference or null -> `folders` |');
		await data[Symbol.asyncDispose]();
	});

	test('every outcome an agent can cause has a line saying what it costs', async () => {
		// The file is the one place an agent learns what happens to each of its
		// edits, and every one of these is silent in the folder itself.
		const data = addressed(await openMemory(shapes), { dataId: shapes.id });
		const { agents } = await agentsFor(
			data as unknown as PushableData & typeof STORE,
			shapes,
		);
		// Keyed by the plan's own vocabulary, so a kind added to `PlanItem` or a
		// reason added to `KeepReason` fails to compile until this file says
		// what it costs. The file has twice been left behind by a wave that
		// changed what a push does.
		const perKind: Record<PlanItem['kind'], string> = {
			value: 'A value in the frontmatter comes back',
			body: 'replaces the note',
			admission: 'becomes a row, and is RENAMED',
			deletion: 'deletes the row, for good',
			kept: 'is left alone',
		};
		const perReason: Record<KeepReason, string> = {
			'row-unwritable': 'cannot write out leaves its file alone',
			'kv-changed': '`kv.json` is read only',
			unreadable: 'Keep the `---` block',
			'table-undeclared': 'The tables',
			'body-unreadable': 'cannot read is left alone',
		};
		for (const phrase of [
			...Object.values(perKind),
			...Object.values(perReason),
		]) {
			expect(agents).toContain(phrase);
		}
		// And the two facts none of the lines states on its own: what a push
		// writes, and that the folder does not update itself (ADR-0341).
		expect(agents).toContain('rewrites only the files');
		expect(agents).toContain('does not update itself');
		await data[Symbol.asyncDispose]();
	});

	test('two writes of one definition are byte-identical', async () => {
		// The host skips a write whose bytes already match, which is what keeps
		// a pull from making Time Machine and Spotlight see the whole folder as
		// new. A generated file that carried a timestamp would break that for
		// every folder, every time.
		const data = addressed(await openMemory(shapes), { dataId: shapes.id });
		const first = await agentsFor(
			data as unknown as PushableData & typeof STORE,
			shapes,
		);
		const second = await agentsFor(
			data as unknown as PushableData & typeof STORE,
			shapes,
		);
		expect(second.agents).toBe(first.agents);
		await data[Symbol.asyncDispose]();
	});

	test("its first line is the one a person needs, and it is the store's file", async () => {
		// Not a person's to keep: it is swept and rewritten like every other
		// file the store owns, so the first line has to say so before anybody
		// puts their own words in it.
		const host = fakeHost();
		const { data } = await notebook();
		expectOk(await pullInto(host, data));
		expect(host.folder.get(AGENTS_PATH)).toContain(
			'A pull replaces every one of them, including this file.',
		);

		host.folder.set(AGENTS_PATH, 'my own words');
		// It is not a row, so nothing plans it and no pull refuses over it.
		expectOk(await pullInto(host, data));
		expect(host.folder.get(AGENTS_PATH)).toContain('### notes/');
		await data[Symbol.asyncDispose]();
	});
});

describe('the whole cycle, as a person walks it (ADR-0341)', () => {
	test('pull, an agent edits, push, break a file, push, pull over it', async () => {
		// Every verb in order, in the sequence a person actually meets them.
		// Each unit test above pins one rule; this pins that they compose, and
		// it is the one place the two verbs are seen disagreeing on purpose:
		// step 5 refuses to destroy a broken file, and step 6 destroys it after
		// saying so.
		const host = fakeHost();
		const { data, noteId } = await notebook();
		const second = data.tables.notes.create({
			title: 'Onboarding',
			pinned: false,
		});
		const trashed = data.tables.notes.create({
			title: 'Standup',
			pinned: false,
		});

		// 1. First pull: an empty folder, so nothing to lose and no dialog.
		const first = await stateOf(host, data);
		expect(first).toEqual({ base: false, unwritten: [] });
		expectOk(await pullInto(host, data, first));

		// 2. An agent edits a title, rewrites a body, drops a stray file. A
		//    person deletes one note's file in Finder.
		host.folder.set(
			`notes/${noteId}.md`,
			(host.folder.get(`notes/${noteId}.md`) as string).replace(
				'"Groceries"',
				'"Budget 2026"',
			),
		);
		host.folder.set(
			`notes/${second.id}.md`,
			'---\ntitle: "Onboarding"\npinned: false\n---\n\nrewritten by the agent\n',
		);
		host.folder.set(
			'notes/scratch.md',
			'---\ntitle: "scratch"\npinned: false\n---\n',
		);
		host.folder.delete(`notes/${trashed.id}.md`);

		// 3. The push overview names all four, and applies them.
		const plan = await planOf(host, data);
		expect(plan.map((i) => i.kind).sort()).toEqual([
			'admission',
			'body',
			'deletion',
			'value',
		]);
		const done = expectOk(
			await push({ data, definition, plan, fetch: host.fetch }),
		);
		expect(done).toMatchObject({ values: 1, bodies: 1, deleted: 1 });
		expect(data.tables.notes.get(noteId)?.title).toBe('Budget 2026');
		expect(data.tables.notes.get(trashed.id)).toBeUndefined();
		expect(host.folder.has('notes/scratch.md')).toBe(false);
		expect(host.folder.has(`notes/${done.admitted[0]?.rowId}.md`)).toBe(true);

		// 4. Break a fence and paste text under it.
		const broken = '---\ntitle: "Budget 2026"\n\nthree paragraphs I typed\n';
		host.folder.set(`notes/${noteId}.md`, broken);

		// 5. The push keeps it, byte for byte, and says so again.
		const kept = await planOf(host, data);
		expect(only(kept, 'kept').reason).toBe('unreadable');
		expectOk(await push({ data, definition, plan: kept, fetch: host.fetch }));
		expect(host.folder.get(`notes/${noteId}.md`)).toBe(broken);
		expect(only(await planOf(host, data), 'kept').reason).toBe('unreadable');

		// 6. The pull writes over it, after listing it.
		const over = await stateOf(host, data);
		expectOk(await pullInto(host, data, over));
		expect(host.folder.get(`notes/${noteId}.md`)).toContain('"Budget 2026"');
		expect(host.folder.get(`notes/${noteId}.md`)).not.toContain(
			'three paragraphs',
		);
		// And the folder is clean.
		expect(await planOf(host, data)).toEqual([]);
		await data[Symbol.asyncDispose]();
	});
});
