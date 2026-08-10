/**
 * The page half of the durability proof. Driven by `../durable-store.ts`.
 *
 * It exposes verbs rather than running a script, so the runner decides when a
 * reload happens, which is the only part of this that matters.
 */
import { defineLens } from '@epicenter/lens';

import { type BrowserStore, open as openBrowser } from '../../../src/store/browser.js';
import type { Application } from '../../../src/store/open.js';

/**
 * Two namespaces, because a namespace is what makes two stores two stores.
 *
 * The control below used to open one namespace under a second NAME and call
 * that a different file. A lens names the store it opens (ADR-0229), so there
 * is no second name left to vary, and the honest control is a second namespace.
 */
const lenses = {
	vault: defineLens({
		namespace: 'so.epicenter.durableprobe',
		tables: { notes: { title: 'string' } },
	}),
	'somewhere-else': defineLens({
		namespace: 'so.epicenter.durableprobe.elsewhere',
		tables: { notes: { title: 'string' } },
	}),
} as const;

type ProbeApplication = Application<(typeof lenses)['vault'], BrowserStore>;

let db: ProbeApplication | undefined;

function bound(): ProbeApplication {
	if (db === undefined) throw new Error('open a store first');
	return db;
}

const out = document.querySelector('#out') as HTMLElement;
function show(value: unknown): void {
	out.textContent = JSON.stringify(value, null, 2);
}

Object.assign(globalThis, {
	async open(name: keyof typeof lenses) {
		const lens = lenses[name];
		if (lens === undefined) return { error: `no lens named ${name}` };
		const opened = await openBrowser(lens);
		if (opened.error !== null) return { error: opened.error.message };
		db = opened.data as ProbeApplication;
		show({ opened: name, namespace: lens.namespace });
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
		const durable = await db.$store.whenDurable();
		return { id: made.data.id, durable: durable.error === null };
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
			durability: db.$store.durability(),
			pressure: db.$store.pressure().data,
		};
	},
});

show({ ready: true });
