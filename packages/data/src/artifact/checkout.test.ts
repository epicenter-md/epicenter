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
	answerKey,
	answersFor,
	type CheckoutFile,
	type CheckoutManifest,
	checkoutLine,
	contentHash,
	diff,
	MANIFEST_PATH,
	type DiscardReason,
	type PlanAnswers,
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
const STORE = {
	dataId: DATA_ID,
	generation: 7,
	baseURL: CLOUD,
	principalId: 'alice',
};

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
		store: STORE,
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
		expect(refused.plan).toEqual([
			{ kind: 'block', path: 'drafts/ideas.md', reason: 'no-base' },
		]);
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
		// Not a diff against Alice's base: a manifest naming another account is
		// no base at all, so every file in the folder is shown whole.
		expect(refused.plan.every((item) => item.kind === 'block')).toBe(true);
		expect(refused.plan[0]).toMatchObject({ reason: 'no-base' });
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
		expect(refused.plan).toEqual([
			{
				kind: 'value',
				path: `notes/${noteId}.md`,
				table: 'notes',
				rowId: noteId,
				name: 'title',
				store: 'Groceries',
				file: 'Shopping',
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
		const refused = expectErr(await pullInto(host, data));
		if (refused.name !== 'WorkingCopyDirty') throw new Error('unreachable');
		expect(only(refused.plan, 'body')).toEqual({
			kind: 'body',
			path: `notes/${noteId}.md`,
			table: 'notes',
			rowId: noteId,
			storeChanged: false,
		});
		await data[Symbol.asyncDispose]();
	});

	test('a missing file and a new file are different facts', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.delete(`notes/${id}.md`);
			folder.set('notes/handwritten.md', '---\ntitle: "mine"\n---\n');
		});
		const refused = expectErr(await pullInto(host, data));
		if (refused.name !== 'WorkingCopyDirty') throw new Error('unreachable');
		expect(only(refused.plan, 'block')).toEqual({
			kind: 'block',
			path: `notes/${noteId}.md`,
			reason: 'file-missing',
		});
		// A file nobody pulled is not a block: it is a row waiting to be made,
		// which is what stops one stray file wedging both directions.
		expect(only(refused.plan, 'discard')).toEqual({
			kind: 'discard',
			path: 'notes/handwritten.md',
			notes: [{ reason: 'row-incomplete', name: 'pinned' }],
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

	test('discarding is the way past, and it is the person saying so', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.set(`notes/${id}.md`, '---\ntitle: "gone"\n---\n');
		});
		const pulled = expectOk(await pullInto(host, data, { discardEdits: true }));
		expect(pulled.files).toBe(4);
		expect(host.folder.get(`notes/${noteId}.md`)).toContain('"Groceries"');
		await data[Symbol.asyncDispose]();
	});

	test('an edit to kv.json is reported, because it is never pushed', async () => {
		const { host, data } = await pulledThenEdited((folder) => {
			folder.set('kv.json', '{"theme":"dark"}');
		});
		const refused = expectErr(await pullInto(host, data));
		if (refused.name !== 'WorkingCopyDirty') throw new Error('unreachable');
		expect(refused.plan).toEqual([
			{ kind: 'discard', path: 'kv.json', notes: [{ reason: 'kv-changed' }] },
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

	const planOf = (host: ReturnType<typeof fakeHost>, data: PushableData) =>
		diff({ data, definition, store: STORE, fetch: host.fetch });

	test('a value the person changed and the store did not is applied', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			setField(folder, `notes/${id}.md`, '"Groceries"', '"Shopping"');
		});
		const plan = expectOk(await planOf(host, data));
		expect(plan).toEqual([
			{
				kind: 'value',
				path: `notes/${noteId}.md`,
				table: 'notes',
				rowId: noteId,
				name: 'title',
				store: 'Groceries',
				file: 'Shopping',
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
		const plan = expectOk(await planOf(host, data));
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
		const plan = expectOk(await planOf(host, data));
		expect(plan).toEqual([]);
		await data[Symbol.asyncDispose]();
	});

	test('all three differing is a conflict, and push will not guess', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			setField(folder, `notes/${id}.md`, '"Groceries"', '"Q3 plan"');
		});
		data.tables.notes.update(noteId, { title: 'Q3 planning' });
		const plan = expectOk(await planOf(host, data));
		expect(only(plan, 'conflict')).toMatchObject({
			name: 'title',
			base: 'Groceries',
			file: 'Q3 plan',
			store: 'Q3 planning',
		});

		const refused = expectErr(
			await push({
				data,
				definition,
				store: STORE,
				plan,
				fetch: host.fetch,
			}),
		);
		expect(refused.name).toBe('PushIncomplete');
		if (refused.name !== 'PushIncomplete') throw new Error('unreachable');
		expect(refused.unanswered).toEqual([`notes/${noteId}.md#title`]);
		// Nothing was applied, and the folder still holds what the person wrote.
		expect(data.tables.notes.get(noteId)?.title).toBe('Q3 planning');
		expect(host.folder.get(`notes/${noteId}.md`)).toContain('"Q3 plan"');
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
		const plan = expectOk(await planOf(host, data));
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
		const plan = expectOk(await planOf(host, data));
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
		const data = await openMemory(refusing);
		const note = data.tables.notes.create({ title: 'x', pinned: false });
		expectOk(
			await pull({ data, definition: refusing, store: STORE, fetch: host.fetch }),
		);
		host.folder.set(
			`notes/${note.id}.md`,
			`${host.folder.get(`notes/${note.id}.md`) as string}\nprose\n`,
		);
		const plan = expectOk(
			await diff({ data, definition: refusing, store: STORE, fetch: host.fetch }),
		);
		expect(only(plan, 'discard').notes).toEqual([
			{ reason: 'body-unreadable' },
		]);
		await data[Symbol.asyncDispose]();
	});

	test('a deletion blocks and a new file does not', async () => {
		// The asymmetry is the point. A deletion has nowhere to go and no answer
		// stands in for one; a new file has two answers and both are honest.
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.delete(`notes/${id}.md`);
			folder.set(
				'notes/handwritten.md',
				'---\ntitle: "mine"\npinned: false\n---\n\nwritten by hand\n',
			);
		});
		const plan = expectOk(await planOf(host, data));
		expect(only(plan, 'block')).toEqual({
			kind: 'block',
			path: `notes/${noteId}.md`,
			reason: 'file-missing',
		});
		expect(only(plan, 'admission')).toEqual({
			kind: 'admission',
			path: 'notes/handwritten.md',
			table: 'notes',
		});
		await data[Symbol.asyncDispose]();
	});

	test('a new file missing a value names the lines to add', async () => {
		// A definition declares no defaults (ADR-0255) and `create` does not
		// validate, so a file missing one would mint a row the application reads
		// as nonconforming and stops showing.
		const { host, data } = await pulledThenEdited((folder) => {
			folder.set(
				'notes/handwritten.md',
				'---\ntitle: "mine"\ncolour: "red"\n---\n',
			);
		});
		const plan = expectOk(await planOf(host, data));
		expect(only(plan, 'discard').notes).toEqual([
			{ reason: 'name-unknown', name: 'colour' },
			{ reason: 'row-incomplete', name: 'pinned' },
		]);
		await data[Symbol.asyncDispose]();
	});

	test('a deleted frontmatter line rewrites the file rather than reading an unset', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.set(
				`notes/${id}.md`,
				`---\ntitle: "Groceries"\n---\n\nbuy milk\n`,
			);
		});
		const plan = expectOk(await planOf(host, data));
		expect(plan).toEqual([
			{
				kind: 'discard',
				path: `notes/${noteId}.md`,
				notes: [{ reason: 'value-removed', name: 'pinned' }],
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

	const planOf = (host: ReturnType<typeof fakeHost>, data: PushableData) =>
		diff({ data, definition, store: STORE, fetch: host.fetch });

	const sendBack = (
		host: ReturnType<typeof fakeHost>,
		data: PushableData,
		plan: PushPlan,
		answers: PlanAnswers = {},
		now = () => new Date('2026-09-02T11:00:00.000Z'),
	) =>
		push({
			data,
			definition,
			store: STORE,
			plan,
			answers,
			fetch: host.fetch,
			now,
		});

	/** The one answer this plan asks for, given as `file`. */
	const takeFile = (plan: PushPlan): PlanAnswers =>
		Object.fromEntries(
			plan
				.filter((item) => answersFor(item).length > 0)
				.map((item) => [answerKey(item), 'file' as const]),
		);

	test('an applied value reaches the store, and the folder is clean after', async () => {
		const { host, data, noteId } = await edited(['"Groceries"', '"Shopping"']);
		const plan = expectOk(await planOf(host, data));

		const pushed = expectOk(await sendBack(host, data, plan));
		expect(pushed).toEqual({ rows: 1, values: 1, bodies: 0, admitted: [] });
		expect(data.tables.notes.get(noteId)?.title).toBe('Shopping');

		// The re-render is what makes the folder never dirty after a push, so a
		// second pull asks nobody anything.
		expect(manifestOf(host.folder).pulledAt).toBe('2026-09-02T11:00:00.000Z');
		expectOk(await pullInto(host, data));
		await data[Symbol.asyncDispose]();
	});

	test('an answered conflict applies the side the person named', async () => {
		const { host, data, noteId } = await edited(['"Groceries"', '"Q3 plan"']);
		data.tables.notes.update(noteId, { title: 'Q3 planning' });
		const plan = expectOk(await planOf(host, data));

		expectOk(
			await sendBack(host, data, plan, {
				[`notes/${noteId}.md#title`]: 'file',
			}),
		);
		expect(data.tables.notes.get(noteId)?.title).toBe('Q3 plan');
		await data[Symbol.asyncDispose]();
	});

	test('answering store keeps the store and rewrites the file', async () => {
		const { host, data, noteId } = await edited(['"Groceries"', '"Q3 plan"']);
		data.tables.notes.update(noteId, { title: 'Q3 planning' });
		const plan = expectOk(await planOf(host, data));

		const pushed = expectOk(
			await sendBack(host, data, plan, {
				[`notes/${noteId}.md#title`]: 'store',
			}),
		);
		// Nothing is written, because answering `store` is writing what is
		// already there. The re-render is what settles the file.
		expect(pushed).toEqual({ rows: 0, values: 0, bodies: 0, admitted: [] });
		expect(data.tables.notes.get(noteId)?.title).toBe('Q3 planning');
		expect(host.folder.get(`notes/${noteId}.md`)).toContain('"Q3 planning"');
		await data[Symbol.asyncDispose]();
	});

	test('a push with anything it cannot carry applies nothing at all', async () => {
		// Half a push is a folder that matches nothing, and the re-render at the
		// end would overwrite whatever it left behind.
		const { host, data, noteId } = await edited(['"Groceries"', '"Shopping"']);
		const plan = expectOk(await planOf(host, data));
		host.folder.set(
			`notes/${noteId}.md`,
			`${host.folder.get(`notes/${noteId}.md`) as string}and eggs\n`,
		);

		const refused = expectErr(await sendBack(host, data, plan));
		expect(refused.name).toBe('PushIncomplete');
		expect(data.tables.notes.get(noteId)?.title).toBe('Groceries');
		await data[Symbol.asyncDispose]();
	});

	test('a plan that stopped being true is refused, and says what is', async () => {
		// Between the dialog and the click the store moved, so the answer a
		// person would have given is to a question that changed. The refusal
		// carries the plan that is true now.
		const { host, data, noteId } = await edited(['"Groceries"', '"Shopping"']);
		const plan = expectOk(await planOf(host, data));
		data.tables.notes.update(noteId, { title: 'Moved underneath' });

		const refused = expectErr(await sendBack(host, data, plan));
		expect(refused.name).toBe('PushIncomplete');
		if (refused.name !== 'PushIncomplete') throw new Error('unreachable');
		expect(only(refused.plan, 'conflict')).toMatchObject({
			name: 'title',
			base: 'Groceries',
			file: 'Shopping',
			store: 'Moved underneath',
		});
		expect(data.tables.notes.get(noteId)?.title).toBe('Moved underneath');
		await data[Symbol.asyncDispose]();
	});

	test('a value that does not fit its field is refused, not applied', async () => {
		// `frontmatter.ts` promises a hand edit cannot change a value's type by
		// accident, and that held only while nothing wrote the parse back. A
		// string in a boolean field would make the row nonconforming, so the
		// store would hold the note and the application would stop showing it.
		const { host, data, noteId } = await edited([
			'pinned: false',
			'pinned: yes',
		]);
		const plan = expectOk(await planOf(host, data));
		expect(plan).toEqual([
			{
				kind: 'discard',
				path: `notes/${noteId}.md`,
				notes: [{ reason: 'value-invalid', name: 'pinned' }],
			},
		]);
		// Unanswered it refuses; answered it rewrites the file and writes
		// nothing, which is the person saying the line goes nowhere.
		expect(expectErr(await sendBack(host, data, plan)).name).toBe(
			'PushIncomplete',
		);
		expectOk(
			await sendBack(host, data, plan, { [`notes/${noteId}.md`]: 'store' }),
		);
		expect(data.tables.notes.get(noteId)?.pinned).toBe(false);
		expect(host.folder.get(`notes/${noteId}.md`)).toContain('pinned: false');
		await data[Symbol.asyncDispose]();
	});

	test('a name the table does not declare is refused, reserved or invented', async () => {
		// `id` and `content` are the row's own and writing either THROWS rather
		// than returning; an invented name would ride through a write untouched
		// and nothing would ever read it back.
		for (const line of ['id: "forged"', 'content: "text"', 'titel: "typo"']) {
			const { host, data, noteId } = await edited([
				'pinned: false',
				`pinned: false\n${line}`,
			]);
			const plan = expectOk(await planOf(host, data));
			expect(only(plan, 'discard')).toMatchObject({
				path: `notes/${noteId}.md`,
				notes: [{ reason: 'name-unknown' }],
			});
			await data[Symbol.asyncDispose]();
		}
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
		const plan = expectOk(await planOf(host, data));

		const pushed = expectOk(await sendBack(host, data, plan, takeFile(plan)));
		expect(pushed.bodies).toBe(1);
		expect(data.tables.notes.get(noteId)?.content).toBe(before);
		expect((before as Y.Type).toString()).toContain('and eggs');
		expectOk(await pullInto(host, data));
		await data[Symbol.asyncDispose]();
	});

	test('a body answered store is put back by the re-render', async () => {
		const { host, data, noteId } = await edited(['buy milk', 'buy milk']);
		host.folder.set(
			`notes/${noteId}.md`,
			`${host.folder.get(`notes/${noteId}.md`) as string}and eggs\n`,
		);
		const plan = expectOk(await planOf(host, data));

		const pushed = expectOk(
			await sendBack(host, data, plan, {
				[`notes/${noteId}.md#content`]: 'store',
			}),
		);
		expect(pushed.bodies).toBe(0);
		expect(host.folder.get(`notes/${noteId}.md`)).not.toContain('and eggs');
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
		const plan = expectOk(await planOf(host, data));

		const pushed = expectOk(await sendBack(host, data, plan, takeFile(plan)));
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

	test('a new file answered store is swept and never becomes a row', async () => {
		const { host, data } = await edited(['buy milk', 'buy milk']);
		host.folder.set(
			'notes/scratch.md',
			'---\ntitle: "scratch"\npinned: false\n---\n',
		);
		const plan = expectOk(await planOf(host, data));

		const pushed = expectOk(
			await sendBack(host, data, plan, { 'notes/scratch.md': 'store' }),
		);
		expect(pushed.admitted).toEqual([]);
		expect(data.tables.notes.ids()).toHaveLength(1);
		expect(host.folder.has('notes/scratch.md')).toBe(false);
		await data[Symbol.asyncDispose]();
	});

	test('a deletion stops the send however everything else is answered', async () => {
		// The one thing left with no answer, and it waits on a table naming a
		// trash field rather than on a better dialog.
		const { host, data, noteId } = await edited(['"Groceries"', '"Shopping"']);
		host.folder.delete(`notes/${noteId}.md`);
		const plan = expectOk(await planOf(host, data));

		const refused = expectErr(
			await sendBack(host, data, plan, takeFile(plan)),
		);
		expect(refused.name).toBe('PushIncomplete');
		if (refused.name !== 'PushIncomplete') throw new Error('unreachable');
		expect(refused.unanswered).toEqual([]);
		expect(only(refused.plan, 'block').reason).toBe('file-missing');
		await data[Symbol.asyncDispose]();
	});

	test('the values land and the folder cannot be rewritten, said as its own outcome', async () => {
		// The push WORKED. Reporting the write failure alone would send a person
		// looking for work that already landed.
		const { host, data, noteId } = await edited(['"Groceries"', '"Shopping"']);
		const plan = expectOk(await planOf(host, data));
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
		data: PushableData,
		of: typeof definition | typeof shapes = definition,
	) {
		const host = fakeHost();
		expectOk(
			await pull({
				data,
				definition: of,
				store: { ...STORE, dataId: of.id },
				fetch: host.fetch,
			}),
		);
		return { host, agents: host.folder.get(AGENTS_PATH) as string };
	}

	test('every table and field the definition declares is in it', async () => {
		// Derived from the definition rather than compared to a fixture, so the
		// test says the rule (everything that exists is named) instead of
		// pinning today's markdown.
		const data = await openMemory(shapes);
		const { agents } = await agentsFor(data as unknown as PushableData, shapes);
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
		const data = await openMemory(shapes);
		const { agents } = await agentsFor(data as unknown as PushableData, shapes);
		const said: Record<DiscardReason, string> = {
			'row-gone': 'rewrites this',
			'kv-changed': 'Do not edit `kv.json`',
			unreadable: 'Keep the `---` block',
			'value-removed': 'Do not remove a frontmatter line',
			'name-unknown': 'Do not invent a field name',
			'value-invalid': 'does not\n  fit its field',
			'table-undeclared': 'The tables',
			'body-unreadable': 'text under the `---` block comes back',
			'row-incomplete': 'every field its table declares',
		};
		for (const phrase of Object.values(said)) {
			expect(agents).toContain(phrase);
		}
		// The two answerable items whose consequence is not a rewrite, and the
		// one thing that stops a send whatever else is answered.
		expect(agents).toContain('becomes a row, and is RENAMED');
		expect(agents).toContain('Do not delete, move, or rename a file');
		// And the fact none of the lines states on its own.
		expect(agents).toContain('applies all of its changes or none');
		await data[Symbol.asyncDispose]();
	});

	test('two writes of one definition are byte-identical', async () => {
		// The host skips a write whose bytes already match, which is what keeps
		// a pull from making Time Machine and Spotlight see the whole folder as
		// new. A generated file that carried a timestamp would break that for
		// every folder, every time.
		const data = await openMemory(shapes);
		const first = await agentsFor(data as unknown as PushableData, shapes);
		const second = await agentsFor(data as unknown as PushableData, shapes);
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
			'Keep anything of your own under a different name',
		);

		host.folder.set(AGENTS_PATH, 'my own words');
		// It is not a row, so nothing plans it and no pull refuses over it.
		expectOk(await pullInto(host, data));
		expect(host.folder.get(AGENTS_PATH)).toContain('### notes/');
		await data[Symbol.asyncDispose]();
	});
});
