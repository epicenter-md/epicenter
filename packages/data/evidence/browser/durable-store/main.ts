/**
 * The page half of the durability proof. Driven by `../durable-store.ts`.
 *
 * It exposes verbs rather than running a script, so the runner decides when a
 * reload happens, which is the only part of this that matters.
 */
import { defineLens } from '@epicenter/lens/lens';

import { type BrowserStore, openBrowserStore } from '../../../src/store/browser.js';
import type { BoundOf } from '../../../src/store/store.js';

const lens = defineLens({
	namespace: 'so.epicenter.durableprobe',
	tables: { notes: { title: 'string' } },
});

let store: BrowserStore | undefined;
let db: BoundOf<typeof lens> | undefined;

function bound(): BoundOf<typeof lens> {
	if (db === undefined) throw new Error('open a store first');
	return db;
}

const out = document.querySelector('#out') as HTMLElement;
function show(value: unknown): void {
	out.textContent = JSON.stringify(value, null, 2);
}

Object.assign(globalThis, {
	async open(name: string) {
		const opened = await openBrowserStore({ name });
		if (opened.error !== null) return { error: opened.error.message };
		store = opened.data;
		const binding = store.bind(lens);
		if (binding.error !== null) return { error: binding.error.message };
		db = binding.data;
		show({ opened: name });
		return { ok: true };
	},

	/** Create a note AND write prose into its document, then wait for durability. */
	async write(title: string, prose: string) {
		const db = bound();
		const made = db.notes.create({ title }, { document: ['body'] });
		if (made.error !== null) return { error: made.error.message };
		const body = db.notes.document(made.data.id)?.get('body', 'text');
		if (body === undefined) return { error: 'the row has no document' };
		body.applyDelta(body.change.insert(prose) as never);
		const durable = await store?.whenDurable();
		return { id: made.data.id, durable: durable?.error === null };
	},

	/** Everything this store can see right now, read synchronously. */
	read() {
		const db = bound();
		const listed = db.notes.list();
		if (listed.error !== null) return { error: listed.error.message };
		const notes = listed.data.rows.map((row) => ({
			title: row.title,
			// Through the CRDT, not through a cache the harness keeps.
			prose: JSON.stringify(
				db.notes.document(row.id)?.get('body', 'text')?.toJSON() ?? null,
			),
		}));
		// `db.query` reads the projection, which is a different relation entirely,
		// so agreeing with `list` is what proves the restored file carried both.
		const counted = db.query`SELECT count(*) AS n FROM notes`;
		return {
			notes: notes.sort((left, right) => left.title.localeCompare(right.title)),
			projected: counted.data?.[0]?.n ?? -1,
			durability: store?.durability(),
			pressure: store?.pressure().data,
		};
	},
});

show({ ready: true });
