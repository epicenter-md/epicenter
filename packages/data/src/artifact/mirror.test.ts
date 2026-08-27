/**
 * The mirror, end to end through a real store (ADR-0271).
 *
 * The sink is injected, so the host is not involved and what is asserted is
 * exactly what would have crossed the wire. What matters here is not that one
 * file appears; it is that a pass is WHOLE, so nothing depends on a commit
 * saying which row moved.
 */
import { describe, expect, test } from 'bun:test';
import { defineData, field } from '@epicenter/data/definition';
import { openMemory } from '../store/memory.js';
import { attachMirror } from './mirror.js';
import type { MirrorSink } from './webview.js';

type MetaRoot = {
	getAttr(key: string): unknown;
	setAttr(key: string, value: unknown): void;
};

const workspace = defineData({
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

/** A folder in memory, plus the log of what was done to it. */
function recordingSink(seed: string[] = []) {
	const files = new Map<string, string>(seed.map((path) => [path, 'stale']));
	const removed: string[] = [];
	const indexed: string[][] = [];
	const sink: MirrorSink = {
		async write(path, contents) {
			files.set(path, contents);
			return { data: undefined, error: null };
		},
		async remove(path) {
			files.delete(path);
			removed.push(path);
			return { data: undefined, error: null };
		},
		async list() {
			return { data: [...files.keys()], error: null };
		},
		async index() {
			// Captured as the folder LOOKED when the index was asked for, which is
			// the fact that matters: the index must never describe a file the
			// sweep was about to remove.
			indexed.push([...files.keys()].sort());
			return { data: undefined, error: null };
		},
	};
	return { files, removed, indexed, sink };
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

describe('attachMirror renders a whole workspace (ADR-0271)', () => {
	test('the first pass renders what is already there', async () => {
		// A workspace changes while an application is closed: another device
		// syncs, and the folder is stale until something renders it whole.
		await using data = openMemory(workspace);
		const made = data.tables.notes.create({ title: 'written before boot' });
		const { files, sink } = recordingSink();

		await using _mirror = attachMirror({
			data,
			definition: workspace,
			workspace: 'account',
			sink,
			log: silent,
			idleMs: 1,
		});
		await settle();

		expect(files.get(`notes/${made.id}.md`)).toContain(
			'title: "written before boot"',
		);
		expect(files.has('kv.json')).toBe(true);
	});

	test('a commit anywhere renders everything, including kv', async () => {
		// The bug a per-row renderer had: kv.json was written by the boot pass
		// and by nothing else, so a kv change never reached the folder until the
		// next launch. A whole pass has one writer and cannot drift from itself.
		await using data = openMemory(workspace);
		const { files, sink } = recordingSink();
		await using _mirror = attachMirror({
			data,
			definition: workspace,
			workspace: 'account',
			sink,
			log: silent,
			idleMs: 1,
		});
		await settle();

		data.kv.update({ theme: 'dark' });
		await settle();

		expect(JSON.parse(files.get('kv.json') ?? 'null')).toEqual({
			theme: 'dark',
		});
	});

	test('a deleted row loses its file', async () => {
		await using data = openMemory(workspace);
		const { files, removed, sink } = recordingSink();
		await using _mirror = attachMirror({
			data,
			definition: workspace,
			workspace: 'account',
			sink,
			log: silent,
			idleMs: 1,
		});
		const made = data.tables.notes.create({ title: 'Groceries' });
		await settle();
		expect(files.has(`notes/${made.id}.md`)).toBe(true);

		data.tables.notes.delete(made.id);
		await settle();

		expect(files.has(`notes/${made.id}.md`)).toBe(false);
		expect(removed).toContain(`notes/${made.id}.md`);
	});

	test('a file left by a row deleted while the app was closed is swept', async () => {
		// The one thing memory cannot know: another device deleted a row, this
		// device was not running, and the file it left is remembered by nothing
		// but the folder. So the first pass asks the folder.
		await using data = openMemory(workspace);
		const { files, sink } = recordingSink([
			'notes/aaaaaaaaaaaaaaaaaaaaaaaa.md',
		]);

		await using _mirror = attachMirror({
			data,
			definition: workspace,
			workspace: 'account',
			sink,
			log: silent,
			idleMs: 1,
		});
		await settle();

		expect(files.has('notes/aaaaaaaaaaaaaaaaaaaaaaaa.md')).toBe(false);
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
							title: String((doc.get('meta') as MetaRoot).getAttr('body') ?? ''),
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
		await using data = openMemory(derived);
		const { files, sink } = recordingSink();
		await using _mirror = attachMirror({
			data,
			definition: derived,
			workspace: 'account',
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
		// anywhere renders the body correctly. A per-row renderer would have left
		// that one file permanently stale instead.
		await using data = openMemory(workspace);
		const { files, sink } = recordingSink();
		await using _mirror = attachMirror({
			data,
			definition: workspace,
			workspace: 'account',
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
		// Every keystroke commits. The debounce is why this is a folder writer
		// and not a write amplifier.
		await using data = openMemory(workspace);
		let passes = 0;
		const { sink } = recordingSink();
		const counting: MirrorSink = {
			...sink,
			async write(path, contents) {
				// Every pass writes `kv.json`, so counting it counts passes.
				if (path === 'kv.json') passes += 1;
				return sink.write(path, contents);
			},
		};
		await using _mirror = attachMirror({
			data,
			definition: workspace,
			workspace: 'account',
			sink: counting,
			log: silent,
			idleMs: 20,
		});
		await settle();
		const afterBoot = passes;

		for (let index = 0; index < 10; index += 1) {
			data.tables.notes.create({ title: `note ${index}` });
		}
		await settle();

		// The boot pass listed the folder; the burst produced exactly one more.
		expect(passes - afterBoot).toBe(1);
	});

	test('disposing stops the mirror and finishes the pass in flight', async () => {
		await using data = openMemory(workspace);
		const { files, sink } = recordingSink();
		const mirror = attachMirror({
			data,
			definition: workspace,
			workspace: 'account',
			sink,
			log: silent,
			idleMs: 1,
		});
		await settle();
		await mirror[Symbol.asyncDispose]();
		files.clear();

		data.tables.notes.create({ title: 'after disposal' });
		await settle();
		expect([...files.keys()]).toEqual([]);
	});

	test('the index is rebuilt after the sweep, never before', async () => {
		// Order is the whole contract: an index built mid-pass would describe a
		// file the sweep is about to take away, and an agent would read a path
		// that is not there.
		await using data = openMemory(workspace);
		const { indexed, sink } = recordingSink([
			'notes/aaaaaaaaaaaaaaaaaaaaaaaa.md',
		]);
		await using _mirror = attachMirror({
			data,
			definition: workspace,
			workspace: 'account',
			sink,
			log: silent,
			idleMs: 1,
		});
		await settle();

		expect(indexed).toHaveLength(1);
		expect(indexed[0]).toEqual(['kv.json']);
	});
});
