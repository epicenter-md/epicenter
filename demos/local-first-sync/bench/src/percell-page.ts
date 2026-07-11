/**
 * Engine B: proposed per-cell Yjs layout + y-indexeddb.
 * One row-presence root map plus one root Y.Map per field (ADR-0118 shape).
 */

import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import {
	churnPlan,
	FIELD_KEYS,
	type FieldKey,
	makeNote,
	measureMemory,
	type NoteRow,
	noteId,
	now,
	remotePlan,
	storageEstimate,
} from './shape';

const DB_NAME = 'bench-percell';

type Cells = Record<FieldKey, Y.Map<unknown>>;

function open() {
	const doc = new Y.Doc({ gc: true });
	const rows = doc.getMap<boolean>('table:notes:rows');
	const cells = Object.fromEntries(
		FIELD_KEYS.map((key) => [key, doc.getMap<unknown>(`table:notes:cell:${key}`)]),
	) as Cells;
	return { doc, rows, cells };
}

let state: ReturnType<typeof open> | null = null;
let idb: IndexeddbPersistence | null = null;

async function attach() {
	state = open();
	idb = new IndexeddbPersistence(DB_NAME, state.doc);
	await idb.whenSynced;
}

function insertRow(s: NonNullable<typeof state>, row: NoteRow) {
	s.rows.set(row.id, true);
	for (const key of FIELD_KEYS) s.cells[key].set(row.id, row[key]);
}

function readRow(s: NonNullable<typeof state>, id: string): NoteRow | null {
	if (!s.rows.has(id)) return null;
	const row = { id } as Record<string, unknown>;
	for (const key of FIELD_KEYS) row[key] = s.cells[key].get(id);
	return row as NoteRow;
}

window.bench = {
	engine: 'percell-yjs',
	async reset() {
		idb?.destroy();
		state?.doc.destroy();
		state = null;
		idb = null;
		await new Promise<void>((resolve) => {
			const req = indexedDB.deleteDatabase(DB_NAME);
			req.onsuccess = () => resolve();
			req.onerror = () => resolve();
			req.onblocked = () => resolve();
		});
	},
	async seed(n) {
		await attach();
		const t0 = now();
		const s = state!;
		const BATCH = 500;
		for (let start = 0; start < n; start += BATCH) {
			s.doc.transact(() => {
				for (let i = start; i < Math.min(start + BATCH, n); i++) {
					insertRow(s, makeNote(i, 0));
				}
			});
			if (start % 5000 === 0) await new Promise((r) => setTimeout(r, 0));
		}
		const t1 = now();
		await new Promise((r) => setTimeout(r, 250));
		return { insertMs: t1 - t0, persistMs: now() - t1 };
	},
	async hydrate() {
		const t0 = now();
		await attach();
		return { hydrateMs: now() - t0, rowCount: state!.rows.size };
	},
	async query100() {
		const t0 = now();
		const s = state!;
		const rows: { id: string; updatedAt: string }[] = [];
		s.rows.forEach((_present, id) => {
			const deletedAt = s.cells.deletedAt.get(id);
			if (deletedAt == null)
				rows.push({ id, updatedAt: s.cells.updatedAt.get(id) as string });
		});
		rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
		const top = rows.slice(0, 100).map((r) => readRow(s, r.id));
		return { ms: now() - t0, count: top.length };
	},
	async search(needle) {
		const t0 = now();
		const s = state!;
		let count = 0;
		s.rows.forEach((_present, id) => {
			const title = s.cells.title.get(id) as string | undefined;
			const preview = s.cells.preview.get(id) as string | undefined;
			if (title?.includes(needle) || preview?.includes(needle)) count++;
		});
		return { ms: now() - t0, count };
	},
	async editOne(index) {
		const s = state!;
		const id = noteId(index);
		let notified: number | null = null;
		const observer = () => {
			notified = now();
		};
		s.cells.title.observe(observer);
		const t0 = now();
		s.cells.title.set(id, `edited ${index}`);
		const ms = (notified ?? now()) - t0;
		s.cells.title.unobserve(observer);
		return { ms };
	},
	async churn(opCount) {
		const s = state!;
		const plan = churnPlan(s.rows.size, opCount);
		const t0 = now();
		const BATCH = 200;
		for (let start = 0; start < plan.length; start += BATCH) {
			s.doc.transact(() => {
				for (const op of plan.slice(start, start + BATCH)) {
					if (op.kind === 'delete') {
						s.rows.delete(op.id);
						for (const key of FIELD_KEYS) s.cells[key].delete(op.id);
					} else if (op.kind === 'reinsert') {
						insertRow(s, makeNote(op.index, op.revision));
					} else {
						s.cells[op.field].set(op.id, op.value);
					}
				}
			});
		}
		return { ms: now() - t0 };
	},
	async remoteApply(editCount) {
		const s = state!;
		const remoteDoc = new Y.Doc({ gc: true });
		Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(s.doc));
		const stateVectorBefore = Y.encodeStateVector(s.doc);
		const plan = remotePlan(s.rows.size, editCount);
		remoteDoc.transact(() => {
			for (const edit of plan) {
				remoteDoc
					.getMap<unknown>(`table:notes:cell:${edit.field}`)
					.set(edit.id, edit.value);
			}
		});
		const diff = Y.encodeStateAsUpdate(remoteDoc, stateVectorBefore);
		const t0 = now();
		Y.applyUpdate(s.doc, diff);
		const ms = now() - t0;
		remoteDoc.destroy();
		return { ms };
	},
	async persistSize() {
		return storageEstimate();
	},
	async memory() {
		return measureMemory();
	},
};

window.benchReady = Promise.resolve();

import { maybeAutorun } from './autorun';
void window.benchReady.then(maybeAutorun);
