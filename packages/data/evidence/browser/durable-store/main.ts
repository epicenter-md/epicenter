/**
 * The page half of the durability proof. Driven by `../durable-store.ts`.
 *
 * It exposes verbs rather than running a script, so the runner decides when a
 * reload happens, which is the only part of this that matters.
 */
import { defineWorkspace } from '@epicenter/workspace';

import { type DeviceStore, openDevice } from '../../../src/store/browser.js';
import type { DataOf } from '../../../src/store/store.js';

/**
 * Two namespaces, because a namespace is what makes two stores two stores.
 *
 * The control below used to open one namespace under a second NAME and call
 * that a different file. A workspace names the store it opens (ADR-0229), so there
 * is no second name left to vary, and the honest control is a second namespace.
 */
const workspaces = {
	vault: defineWorkspace({
		namespace: 'so.epicenter.durableprobe',
		tables: { notes: { title: 'string' } },
	}),
	'somewhere-else': defineWorkspace({
		namespace: 'so.epicenter.durableprobe.elsewhere',
		tables: { notes: { title: 'string' } },
	}),
} as const;

type ProbeApplication = DataOf<(typeof workspaces)['vault'], DeviceStore>;

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
	async open(name: keyof typeof workspaces) {
		const workspace = workspaces[name];
		if (workspace === undefined) return { error: `no workspace named ${name}` };
		// The device document: this probe proves durability, and a device
		// document is the one that never has a sync story to confound it.
		const opened = await openDevice(workspace);
		if (opened.error !== null) return { error: opened.error.message };
		db = opened.data;
		show({ opened: name, namespace: workspace.namespace });
		return { ok: true };
	},

	/** Create a note AND write prose into its document, then wait for durability. */
	async write(title: string, prose: string) {
		const db = bound();
		const made = db.tables.notes.create({ title }, { document: ['body'] });
		if (made.error !== null) return { error: made.error.message };
		const body = db.tables.notes.document(made.data.id)?.get('body', 'text');
		if (body === undefined) return { error: 'the row has no document' };
		body.applyDelta(body.change.insert(prose) as never);
		await db.store.persistence.flush();
		return {
			id: made.data.id,
			durable: db.store.persistence.get() === 'saved',
		};
	},

	/** Everything this store can see right now, read synchronously. */
	read() {
		const db = bound();
		const listed = db.tables.notes.list();
		const notes = listed.rows.map((row) => ({
			title: row.title,
			// Through the CRDT, not through a cache the harness keeps.
			prose: JSON.stringify(
				db.tables.notes.document(row.id)?.get('body', 'text')?.toJSON() ?? null,
			),
		}));
		return {
			notes: notes.sort((left, right) => left.title.localeCompare(right.title)),
			durability: { healthy: db.store.persistence.get() !== 'blocked' },
			pressure: db.store.pressure(),
		};
	},
});

show({ ready: true });
