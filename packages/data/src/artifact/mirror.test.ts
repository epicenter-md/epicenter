/**
 * The mirror, end to end through a real store (ADR-0271).
 *
 * The sink is injected, so the host is not involved and what is asserted is
 * exactly what would have crossed the wire. What matters here is not that one
 * file appears; it is that a pass STATES what the store holds, so nothing
 * depends on a commit saying which row moved and nothing asks the folder what
 * it currently contains.
 *
 * The sweep itself is not tested here, deliberately. A pass names what should
 * exist and the host removes the rest, so "what gets deleted" is the host's
 * behaviour and belongs to the host's tests.
 */

import { describe, expect, test } from 'bun:test';
import { defineData, defineTable, field } from '@epicenter/data/definition';
import * as Y from '@y/y';
import { Ok } from 'wellcrafted/result';
import { openMemory } from '../store/memory.js';
import { attachMirror, type MirrorSink, MirrorSinkError } from './mirror.js';

const store = defineData({
	id: 'so.epicenter.honeycrisp',
	kv: { theme: field.string() },
	tables: {
		notes: defineTable({
			fields: { title: field.string(), body: field.type() },
			file: {
				serialize: (row) => ({
					data: { title: row.title },
					content: row.body.toString(),
				}),
				deserialize: (file) => {
					const body = new Y.Type();
					if (file.content !== '') body.insert(0, [file.content]);
					return Ok({ title: String(file.data.title ?? ''), body });
				},
			},
		}),
	},
});

/**
 * What crossed the wire, read back as the two things a pass carries.
 *
 * It parses rather than storing raw batches, because the assertions are about
 * the pass and not about where a batch boundary happened to land.
 */
function recordingSink(refuse: () => boolean = () => false) {
	const batches: string[] = [];
	const files = new Map<string, string>();
	const manifests: string[][] = [];
	const sink: MirrorSink = {
		async send(ndjson) {
			batches.push(ndjson);
			if (refuse()) {
				return {
					data: null,
					error: MirrorSinkError.MirrorSendFailed({ status: 500 }),
				} as never;
			}
			for (const line of ndjson.split('\n')) {
				if (line.trim() === '') continue;
				const value = JSON.parse(line) as
					| { path: string; contents: string }
					| { manifest: string[] };
				if ('manifest' in value) manifests.push(value.manifest);
				else files.set(value.path, value.contents);
			}
			return { data: undefined, error: null };
		},
	};
	return { batches, files, manifests, sink };
}

const silent = {
	error: () => undefined,
	warn: () => undefined,
	info: () => undefined,
	debug: () => undefined,
	trace: () => undefined,
};

/** Let a scheduled pass run. Every render is asynchronous by construction. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

/** The manifest of the last completed pass. */
const latest = (manifests: string[][]) => manifests.at(-1) ?? [];

describe('attachMirror states a whole store (ADR-0271)', () => {
	test('the first pass renders what is already there', async () => {
		await using data = await openMemory(store);
		const made = data.tables.notes.create({ title: 'Groceries' });
		const { files, manifests, sink } = recordingSink();

		await using _mirror = attachMirror({
			data,
			definition: store,
			place: 'account',
			sink,
			log: silent,
			idleMs: 1,
		});
		await settle();

		expect(files.get(`notes/${made.id}.md`)).toContain('title: "Groceries"');
		expect(latest(manifests)).toEqual(['kv.json', `notes/${made.id}.md`]);
	});

	test('a commit anywhere renders everything, including kv', async () => {
		await using data = await openMemory(store);
		const made = data.tables.notes.create({ title: 'Groceries' });
		const { files, manifests, sink } = recordingSink();
		await using _mirror = attachMirror({
			data,
			definition: store,
			place: 'account',
			sink,
			log: silent,
			idleMs: 1,
		});
		await settle();

		// A kv write is not a table commit, and under a per-row renderer it never
		// reached the folder. A whole pass does not care what changed.
		data.kv.update({ theme: 'dark' });
		await settle();

		expect(files.get('kv.json')).toContain('dark');
		expect(latest(manifests)).toContain(`notes/${made.id}.md`);
	});

	test('a deleted row leaves the manifest', async () => {
		await using data = await openMemory(store);
		const made = data.tables.notes.create({ title: 'Groceries' });
		const { manifests, sink } = recordingSink();
		await using _mirror = attachMirror({
			data,
			definition: store,
			place: 'account',
			sink,
			log: silent,
			idleMs: 1,
		});
		await settle();
		expect(latest(manifests)).toContain(`notes/${made.id}.md`);

		data.tables.notes.delete(made.id);
		await settle();

		// The mirror never says "delete this". It says what is left, and the host
		// removes what it holds that the manifest does not name.
		expect(latest(manifests)).toEqual(['kv.json']);
	});

	test('a rich-field edit reaches the file, with nothing derived to trigger it', async () => {
		// The signal the collapse restored (ADR-0295). A rich field is a nested
		// type on the row, so a keystroke bubbles through `changedParentTypes`
		// to the table root and the store's commit listener hears it. Before the
		// collapse a body edit reached `onCommitted` only by way of a derived
		// write onto the row, so a table declaring no derivation wrote bytes
		// that notified nobody and the folder stayed stale until the next
		// unrelated commit.
		await using data = await openMemory(store);
		const { files, sink } = recordingSink();
		await using _mirror = attachMirror({
			data,
			definition: store,
			place: 'account',
			sink,
			log: silent,
			idleMs: 1,
		});
		const made = data.tables.notes.create({ title: 'Groceries' });
		await settle();

		const content = data.tables.notes.content(made.id);
		if (content === undefined) throw new Error('the row has no content');
		content.types.body.insert(0, ['buy milk']);
		await settle();

		expect(files.get(`notes/${made.id}.md`)).toContain('buy milk');
	});

	test('a burst of commits costs one pass, not one per commit', async () => {
		await using data = await openMemory(store);
		const { manifests, sink } = recordingSink();
		await using _mirror = attachMirror({
			data,
			definition: store,
			place: 'account',
			sink,
			log: silent,
			idleMs: 20,
		});
		await settle();
		const before = manifests.length;

		for (let index = 0; index < 10; index += 1) {
			data.tables.notes.create({ title: `note ${index}` });
		}
		await settle();

		expect(manifests.length - before).toBe(1);
	});

	test('disposing stops the mirror and finishes the pass in flight', async () => {
		await using data = await openMemory(store);
		const { manifests, sink } = recordingSink();
		const mirror = attachMirror({
			data,
			definition: store,
			place: 'account',
			sink,
			log: silent,
			idleMs: 1,
		});
		await settle();
		await mirror[Symbol.asyncDispose]();
		const after = manifests.length;

		data.tables.notes.create({ title: 'after disposal' });
		await settle();

		expect(manifests.length).toBe(after);
	});

	test('a row whose render failed stays in the manifest', async () => {
		// The host removes what its folder holds and the manifest does not name.
		// A row whose codec threw produced no contents, and leaving it out of the
		// manifest would turn one bad note into a note that vanished from the
		// folder somebody is reading. Stale beats deleted.
		let explode = false;
		const throwing = defineData({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: {
				notes: defineTable({
					fields: { title: field.string(), body: field.type() },
					file: {
						serialize: () => {
							if (explode) throw new Error('the codec refused');
							return { data: {}, content: '' };
						},
						deserialize: () => Ok({ title: '' }),
					},
				}),
			},
		});
		await using data = await openMemory(throwing);
		const made = data.tables.notes.create({ title: 'kept' });
		const { files, manifests, sink } = recordingSink();
		await using _mirror = attachMirror({
			data,
			definition: throwing,
			place: 'account',
			sink,
			log: silent,
			idleMs: 1,
		});
		await settle();
		expect(files.has(`notes/${made.id}.md`)).toBe(true);

		explode = true;
		data.tables.notes.update(made.id, { title: 'edited' });
		await settle();

		// No contents for it this pass, and still named, so the host keeps the
		// file it already has.
		expect(latest(manifests)).toContain(`notes/${made.id}.md`);
	});

	test('a definition that will not compile sends no manifest at all', async () => {
		// `renderArtifact` yields one error and stops, so the pass enumerates no
		// paths. Sending an empty manifest would tell the host every file is
		// gone, which is every row deleted over a programmer error.
		await using data = await openMemory(store);
		data.tables.notes.create({ title: 'still here' });
		const { manifests, sink } = recordingSink();
		const broken = { ...store, id: 'Not A Database Id' } as never;
		await using _mirror = attachMirror({
			data,
			definition: broken,
			place: 'account',
			sink,
			log: silent,
			idleMs: 1,
		});
		await settle();

		expect(manifests).toEqual([]);
	});

	test('a pass larger than one batch is split, and only the last carries the manifest', async () => {
		await using data = await openMemory(store);
		for (let index = 0; index < 20; index += 1) {
			data.tables.notes.create({ title: `note ${index}` });
		}
		const { batches, manifests, files, sink } = recordingSink();
		await using _mirror = attachMirror({
			data,
			definition: store,
			place: 'account',
			sink,
			log: silent,
			idleMs: 1,
			batchBytes: 200,
		});
		await settle();

		expect(batches.length).toBeGreaterThan(1);
		expect(manifests.length).toBe(1);
		// Every file still arrived, and the manifest names all of them.
		expect(files.size).toBe(21);
		expect(latest(manifests).length).toBe(21);
		// The manifest is in the last batch, which is what makes an interrupted
		// pass leave the folder alone.
		expect(batches.at(-1)).toContain('"manifest"');
	});

	test('a batch the host refused costs its files, not the folder', async () => {
		let refusing = false;
		await using data = await openMemory(store);
		data.tables.notes.create({ title: 'kept' });
		const { manifests, sink } = recordingSink(() => refusing);
		await using _mirror = attachMirror({
			data,
			definition: store,
			place: 'account',
			sink,
			log: silent,
			idleMs: 1,
		});
		await settle();
		const before = manifests.length;

		refusing = true;
		data.tables.notes.create({ title: 'lost' });
		await settle();

		// Nothing new landed, and nothing was retried: the store already
		// persisted the commit, so the next pass renders it again.
		expect(manifests.length).toBe(before);
		refusing = false;
		data.tables.notes.create({ title: 'recovered' });
		await settle();
		expect(latest(manifests).length).toBe(4);
	});
});
