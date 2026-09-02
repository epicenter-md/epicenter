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
	diff,
	MANIFEST_PATH,
	type PushableData,
	type PushPlan,
	pull,
	push,
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
		expect(refused.plan.refusals).toEqual([
			{ path: 'drafts/ideas.md', reason: 'no-base' },
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
		expect(refused.plan.refusals[0]?.reason).toBe('no-base');
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
		expect(refused.plan.rows).toEqual([
			{
				table: 'notes',
				rowId: noteId,
				values: [{ name: 'title', store: 'Groceries', file: 'Shopping' }],
				conflicts: [],
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
		expect(refused.plan.refusals[0]?.reason).toBe('body-changed');
		await data[Symbol.asyncDispose]();
	});

	test('a missing file and a new file are different facts', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.delete(`notes/${id}.md`);
			folder.set('notes/handwritten.md', '---\ntitle: "mine"\n---\n');
		});
		const refused = expectErr(await pullInto(host, data));
		if (refused.name !== 'WorkingCopyDirty') throw new Error('unreachable');
		expect(refused.plan.refusals).toEqual(
			expect.arrayContaining([
				{ path: `notes/${noteId}.md`, reason: 'file-missing' },
				{ path: 'notes/handwritten.md', reason: 'new-file' },
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
		expect(refused.plan.refusals).toEqual([
			{ path: 'kv.json', reason: 'kv-changed' },
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
		diff({
			data,
			definition,
			dataId: DATA_ID,
			baseURL: CLOUD,
			principalId: 'alice',
			fetch: host.fetch,
		});

	test('a value the person changed and the store did not is applied', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			setField(folder, `notes/${id}.md`, '"Groceries"', '"Shopping"');
		});
		const plan = expectOk(await planOf(host, data));
		expect(plan.refusals).toEqual([]);
		expect(plan.rows).toEqual([
			{
				table: 'notes',
				rowId: noteId,
				values: [{ name: 'title', store: 'Groceries', file: 'Shopping' }],
				conflicts: [],
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
		expect(plan.rows[0]?.values).toEqual([
			{ name: 'pinned', store: false, file: true },
		]);
		await data[Symbol.asyncDispose]();
	});

	test('the same edit on both sides is already converged', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			setField(folder, `notes/${id}.md`, '"Groceries"', '"Shopping"');
		});
		data.tables.notes.update(noteId, { title: 'Shopping' });
		const plan = expectOk(await planOf(host, data));
		expect(plan.rows).toEqual([]);
		await data[Symbol.asyncDispose]();
	});

	test('all three differing is a conflict, and push will not guess', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			setField(folder, `notes/${id}.md`, '"Groceries"', '"Q3 plan"');
		});
		data.tables.notes.update(noteId, { title: 'Q3 planning' });
		const plan = expectOk(await planOf(host, data));
		expect(plan.rows[0]?.conflicts).toEqual([
			{
				name: 'title',
				base: 'Groceries',
				file: 'Q3 plan',
				store: 'Q3 planning',
			},
		]);

		const refused = expectErr(
			await push({
				data,
				definition,
				dataId: DATA_ID,
				generation: 7,
				baseURL: CLOUD,
				principalId: 'alice',
				plan,
				fetch: host.fetch,
			}),
		);
		expect(refused.name).toBe('PushIncomplete');
		if (refused.name !== 'PushIncomplete') throw new Error('unreachable');
		expect(refused.unanswered).toEqual([`notes/${noteId}#title`]);
		// Nothing was applied, and the folder still holds what the person wrote.
		expect(data.tables.notes.get(noteId)?.title).toBe('Q3 planning');
		expect(host.folder.get(`notes/${noteId}.md`)).toContain('"Q3 plan"');
		await data[Symbol.asyncDispose]();
	});

	test('a body edit is refused, because a body does not read back', async () => {
		// ADR-0329's whole point, and the reason a push says so rather than
		// letting the re-render overwrite it.
		const { host, data } = await pulledThenEdited((folder, id) => {
			folder.set(
				`notes/${id}.md`,
				`${folder.get(`notes/${id}.md`) as string}and eggs\n`,
			);
		});
		const plan = expectOk(await planOf(host, data));
		expect(plan.refusals[0]?.reason).toBe('body-changed');
		await data[Symbol.asyncDispose]();
	});

	test('a new file and a deletion are refused, each for its own reason', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.delete(`notes/${id}.md`);
			folder.set('notes/handwritten.md', '---\ntitle: "mine"\n---\n');
		});
		const plan = expectOk(await planOf(host, data));
		expect(plan.refusals).toEqual(
			expect.arrayContaining([
				{ path: `notes/${noteId}.md`, reason: 'file-missing' },
				{ path: 'notes/handwritten.md', reason: 'new-file' },
			]),
		);
		await data[Symbol.asyncDispose]();
	});

	test('a deleted frontmatter line is refused rather than read as an unset', async () => {
		const { host, data, noteId } = await pulledThenEdited((folder, id) => {
			folder.set(
				`notes/${id}.md`,
				`---\ntitle: "Groceries"\n---\n\nbuy milk\n`,
			);
		});
		const plan = expectOk(await planOf(host, data));
		expect(plan.refusals).toEqual([
			{ path: `notes/${noteId}.md`, name: 'pinned', reason: 'value-removed' },
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
		diff({
			data,
			definition,
			dataId: DATA_ID,
			baseURL: CLOUD,
			principalId: 'alice',
			fetch: host.fetch,
		});

	const sendBack = (
		host: ReturnType<typeof fakeHost>,
		data: PushableData,
		plan: PushPlan,
		resolutions: Record<string, 'file' | 'store'> = {},
		now = () => new Date('2026-09-02T11:00:00.000Z'),
	) =>
		push({
			data,
			definition,
			dataId: DATA_ID,
			generation: 7,
			baseURL: CLOUD,
			principalId: 'alice',
			plan,
			resolutions,
			fetch: host.fetch,
			now,
		});

	test('an applied value reaches the store, and the folder is clean after', async () => {
		const { host, data, noteId } = await edited(['"Groceries"', '"Shopping"']);
		const plan = expectOk(await planOf(host, data));

		const pushed = expectOk(await sendBack(host, data, plan));
		expect(pushed).toEqual({ rows: 1, values: 1 });
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
				[`notes/${noteId}#title`]: 'file',
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
				[`notes/${noteId}#title`]: 'store',
			}),
		);
		// Nothing is written, because answering `store` is writing what is
		// already there. The re-render is what settles the file.
		expect(pushed).toEqual({ rows: 0, values: 0 });
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
		expect(refused.plan.rows[0]?.conflicts[0]).toMatchObject({
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
		expect(plan.refusals).toEqual([
			{ path: `notes/${noteId}.md`, name: 'pinned', reason: 'value-invalid' },
		]);
		expect(expectErr(await sendBack(host, data, plan)).name).toBe(
			'PushIncomplete',
		);
		expect(data.tables.notes.get(noteId)?.pinned).toBe(false);
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
			expect(plan.refusals[0]).toMatchObject({
				path: `notes/${noteId}.md`,
				reason: 'name-unknown',
			});
			await data[Symbol.asyncDispose]();
		}
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
