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
import { defineData, field } from '@epicenter/data/definition';
import { openMemory } from '../store/memory.js';
import { attachMirror, type MirrorSink, MirrorSinkError } from './mirror.js';

type MetaRoot = {
	getAttr(key: string): unknown;
	setAttr(key: string, value: unknown): void;
};

const store = defineData({
	id: 'so.epicenter.honeycrisp',
	kv: { theme: field.string() },
	tables: {
		notes: {
			fields: { title: field.string() },
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

	test('a body edit reaches the file when the table declares a derivation', async () => {
		const derived = defineData({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: {
				notes: {
					fields: { title: field.string() },
					document: {
						// Honeycrisp's shape: a body edit writes derived fields onto
						// the row, which IS a table commit, which is what `onCommitted`
						// hears. That is how a document change reaches the folder today.
						derive: (doc) => ({
							title: String(
								(doc.get('meta') as MetaRoot).getAttr('body') ?? '',
							),
						}),
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
		await using data = await openMemory(derived);
		const { files, sink } = recordingSink();
		await using _mirror = attachMirror({
			data,
			definition: derived,
			place: 'account',
			sink,
			log: silent,
			idleMs: 1,
		});
		const made = data.tables.notes.create({ title: '' });
		await settle();

		{
			const opened = await data.tables.notes.openDocument(made.id);
			const handle = opened.data;
			if (handle === undefined || handle === null) {
				throw new Error('the document should open');
			}
			handle.get('meta').setAttr('body' as never, 'buy milk' as never);
			handle[Symbol.dispose]();
		}
		await settle();

		expect(files.get(`notes/${made.id}.md`)).toContain('buy milk');
	});

	test('a body edit on a table with no derivation does not trigger a pass', async () => {
		// The store's signal gap, stated rather than worked around. A commit into
		// a row's own document reaches `onCommitted` only by way of a derived
		// write onto the row (ADR-0264) or a store-managed `updatedAt`
		// (ADR-0265); a table declaring neither commits bytes that notify nobody.
		//
		// Whole rendering is what makes this survivable rather than corrupting:
		// nothing is written WRONG, the folder is only late, and the next commit
		// anywhere renders the body correctly.
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

		{
			const opened = await data.tables.notes.openDocument(made.id);
			const handle = opened.data;
			if (handle === undefined || handle === null) {
				throw new Error('the document should open');
			}
			handle.get('meta').setAttr('body' as never, 'buy milk' as never);
			handle[Symbol.dispose]();
		}
		await settle();
		expect(files.get(`notes/${made.id}.md`)).not.toContain('buy milk');

		// And the next commit anywhere picks it up, because a pass reads current
		// state rather than a queue of what it was told.
		data.tables.notes.create({ title: 'anything' });
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
				notes: {
					fields: { title: field.string() },
					document: {
						file: {
							serialize: () => {
								if (explode) throw new Error('the codec refused');
								return '';
							},
							deserialize: () => undefined,
						},
					},
				},
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
