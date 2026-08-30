/**
 * The page half of the durability proof. Driven by `../durable-store.ts`.
 *
 * It exposes verbs rather than running a script, so the runner decides when a
 * reload happens, which is the only part of this that matters.
 */
import { defineData, defineTable, field } from '@epicenter/data/definition';
import * as Y from '@y/y';
import { Ok } from 'wellcrafted/result';

import {
	importGeneration,
	type LocalStore,
	listLocalGenerations,
	openDatabase,
} from '../../../src/store/browser.js';
import type { DataOf } from '../../../src/store/store.js';

/**
 * Two namespaces, because a dataId is what makes two stores two stores.
 *
 * The control below used to open one dataId under a second NAME and call
 * that a different file. A workspace names the store it opens (ADR-0229), so there
 * is no second name left to vary, and the honest control is a second dataId.
 */
const workspaces = {
	vault: defineData({
		id: 'so.epicenter.durableprobe',
		kv: {},
		tables: {
			notes: defineTable({
				scalars: { title: field.string() },
				types: ['body'],
				file: {
					serialize: (row) => ({
						data: { title: row.title },
						content: row.body.toString(),
					}),
					deserialize: (file) => {
						const body = new Y.Type();
						if (file.content !== '') body.insert(0, [file.content]);
						return Ok({ body, title: String(file.data.title ?? '') });
					},
				},
			}),
		},
	}),
	'somewhere-else': defineData({
		id: 'so.epicenter.durableprobe.elsewhere',
		kv: {},
		tables: {
			notes: defineTable({
				scalars: { title: field.string() },
				types: ['body'],
				file: {
					serialize: (row) => ({
						data: { title: row.title },
						content: row.body.toString(),
					}),
					deserialize: (file) => {
						const body = new Y.Type();
						if (file.content !== '') body.insert(0, [file.content]);
						return Ok({ body, title: String(file.data.title ?? '') });
					},
				},
			}),
		},
	}),
} as const;

type ProbeApplication = DataOf<(typeof workspaces)['vault'], LocalStore>;

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
		// The local database: this probe proves durability, and a device-owned
		// generation is the one that never has a sync story to confound it.
		//
		// Imported on first use, because a generation number is an address and
		// opening never invents one (ADR-0292). Importing an empty state is
		// what "create a new database on this device" is, and the second open
		// of the same page finds a cache hit and imports nothing.
		if ((await listLocalGenerations(workspace.id)).length === 0) {
			const empty = new Y.Doc({ gc: true });
			const state = new Uint8Array(Y.encodeStateAsUpdateV2(empty));
			empty.destroy();
			const created = await importGeneration(workspace, state);
			if (created.error !== null) return { error: created.error.message };
		}
		const opened = await openDatabase(workspace, { generation: 1 });
		if (opened.error !== null) {
			const cause = (opened.error as { cause?: unknown }).cause;
			return {
				error: opened.error.message,
				cause: cause instanceof Error ? cause.message : String(cause),
			};
		}
		db = opened.data;
		show({ opened: name, dataId: workspace.id });
		return { ok: true };
	},

	/** Create a note AND write prose into its type field, then wait for durability. */
	async write(title: string, prose: string) {
		const db = bound();
		const made = db.tables.notes.create({ title });
		const body = db.tables.notes.get(made.id)?.body;
		if (body === undefined) return { error: 'the row has no body' };
		body.applyDelta(body.change.insert(prose) as never);
		await db.persistence.flush();
		return {
			id: made.id,
			durable: db.persistence.get() === 'saved',
		};
	},

	/** Everything this store can see right now, prose and all. */
	async read() {
		const db = bound();
		const listed = db.tables.notes;
		const notes: { title: string; prose: string }[] = [];
		for (const row of listed.rows) {
			// Through the CRDT, not through a cache the harness keeps.
			notes.push({
				title: row.title,
				prose: JSON.stringify(
					db.tables.notes.get(row.id)?.body.toJSON() ?? null,
				),
			});
		}
		return {
			notes: notes.sort((left, right) => left.title.localeCompare(right.title)),
			durability: { healthy: db.persistence.get() !== 'blocked' },
			pressure: db.pressure(),
		};
	},
});

show({ ready: true });
