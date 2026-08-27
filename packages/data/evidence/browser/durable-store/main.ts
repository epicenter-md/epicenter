/**
 * The page half of the durability proof. Driven by `../durable-store.ts`.
 *
 * It exposes verbs rather than running a script, so the runner decides when a
 * reload happens, which is the only part of this that matters.
 */
import { defineData, field } from '@epicenter/data/definition';

import { type DeviceStore, openDevice } from '../../../src/store/browser.js';
import type { DataOf } from '../../../src/store/store.js';

/**
 * Two namespaces, because a databaseId is what makes two stores two stores.
 *
 * The control below used to open one databaseId under a second NAME and call
 * that a different file. A workspace names the store it opens (ADR-0229), so there
 * is no second name left to vary, and the honest control is a second databaseId.
 */
const workspaces = {
	vault: defineData({
		id: 'so.epicenter.durableprobe',
		kv: {},
		tables: { notes: { title: field.string() } },
	}),
	'somewhere-else': defineData({
		id: 'so.epicenter.durableprobe.elsewhere',
		kv: {},
		tables: { notes: { title: field.string() } },
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
		show({ opened: name, databaseId: workspace.id });
		return { ok: true };
	},

	/** Create a note AND write prose into its document, then wait for durability. */
	async write(title: string, prose: string) {
		const db = bound();
		const made = db.tables.notes.create({ title });
		const opened = await db.tables.notes.openDocument(made.id);
		if (opened.error !== null) return { error: opened.error.message };
		const body = opened.data?.get('body', 'text');
		if (body === undefined) return { error: 'the row has no document' };
		body.applyDelta(body.change.insert(prose) as never);
		await db.store.persistence.flush();
		opened.data?.[Symbol.dispose]();
		return {
			id: made.id,
			durable: db.store.persistence.get() === 'saved',
		};
	},

	/** Everything this store can see right now, prose hydrated per row. */
	async read() {
		const db = bound();
		const listed = db.tables.notes.list();
		const notes: { title: string; prose: string }[] = [];
		for (const row of listed.rows) {
			// Through the CRDT, not through a cache the harness keeps.
			const opened = await db.tables.notes.openDocument(row.id);
			if (opened.error !== null) return { error: opened.error.message };
			notes.push({
				title: row.title,
				prose: JSON.stringify(
					opened.data?.get('body', 'text')?.toJSON() ?? null,
				),
			});
			opened.data?.[Symbol.dispose]();
		}
		return {
			notes: notes.sort((left, right) => left.title.localeCompare(right.title)),
			durability: { healthy: db.store.persistence.get() !== 'blocked' },
			pressure: db.store.pressure(),
		};
	},
});

show({ ready: true });
