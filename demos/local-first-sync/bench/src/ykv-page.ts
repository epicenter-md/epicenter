/**
 * Engine A: current whole-row YKeyValueLww + y-indexeddb.
 * One LWW entry per row in a Y.Array, exactly like packages/workspace tables.
 */

import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import {
	churnPlan,
	makeNote,
	measureMemory,
	type NoteRow,
	noteId,
	now,
	remotePlan,
	storageEstimate,
} from './shape';
import { YKeyValueLww } from './y-keyvalue-lww';

const DB_NAME = 'bench-ykv';

type Stored = NoteRow;

function open() {
	const doc = new Y.Doc({ gc: true });
	const arr = doc.getArray<{ key: string; val: Stored; ts: number }>(
		'table:notes',
	);
	const ykv = new YKeyValueLww<Stored>(arr);
	return { doc, ykv };
}

let state: ReturnType<typeof open> | null = null;
let idb: IndexeddbPersistence | null = null;

async function attach() {
	state = open();
	idb = new IndexeddbPersistence(DB_NAME, state.doc);
	await idb.whenSynced;
}

/** Wait until y-indexeddb has flushed pending stored updates (best effort). */
async function idbSettled() {
	// y-indexeddb stores each update transactionally; give the queue a beat and
	// force a compaction checkpoint by reading the count.
	await new Promise((r) => setTimeout(r, 250));
}

window.bench = {
	engine: 'ykv-whole-row',
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
		const { doc, ykv } = state!;
		const BATCH = 500;
		for (let start = 0; start < n; start += BATCH) {
			doc.transact(() => {
				for (let i = start; i < Math.min(start + BATCH, n); i++) {
					ykv.set(noteId(i), makeNote(i, 0));
				}
			});
			// Yield so IndexedDB writes interleave like a real app.
			if (start % 5000 === 0) await new Promise((r) => setTimeout(r, 0));
		}
		const t1 = now();
		await idbSettled();
		return { insertMs: t1 - t0, persistMs: now() - t1 };
	},
	async hydrate() {
		const t0 = now();
		await attach();
		const count = state!.ykv.size;
		return { hydrateMs: now() - t0, rowCount: count };
	},
	async query100() {
		const t0 = now();
		const rows: NoteRow[] = [];
		for (const entry of state!.ykv.map.values()) {
			if (entry.val.deletedAt == null) rows.push(entry.val);
		}
		rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
		const top = rows.slice(0, 100);
		return { ms: now() - t0, count: top.length };
	},
	async search(needle) {
		const t0 = now();
		let count = 0;
		for (const entry of state!.ykv.map.values()) {
			if (
				entry.val.title.includes(needle) ||
				entry.val.preview.includes(needle)
			)
				count++;
		}
		return { ms: now() - t0, count };
	},
	async editOne(index) {
		const id = noteId(index);
		const { ykv } = state!;
		let notified: number | null = null;
		const observer = () => {
			notified = now();
		};
		ykv.yarray.observeDeep(observer);
		const t0 = now();
		const current = ykv.get(id);
		if (current) ykv.set(id, { ...current, title: `edited ${index}` });
		const ms = (notified ?? now()) - t0;
		ykv.yarray.unobserveDeep(observer);
		return { ms };
	},
	async churn(opCount) {
		const { doc, ykv } = state!;
		const plan = churnPlan(ykv.size, opCount);
		const t0 = now();
		const BATCH = 200;
		for (let start = 0; start < plan.length; start += BATCH) {
			doc.transact(() => {
				for (const op of plan.slice(start, start + BATCH)) {
					if (op.kind === 'delete') ykv.delete(op.id);
					else if (op.kind === 'reinsert')
						ykv.set(noteId(op.index), makeNote(op.index, op.revision));
					else {
						const row = ykv.get(op.id);
						if (row) ykv.set(op.id, { ...row, [op.field]: op.value });
					}
				}
			});
		}
		return { ms: now() - t0 };
	},
	async remoteApply(editCount) {
		const { doc, ykv } = state!;
		// Build the remote client's doc from current state, apply its edits,
		// then apply the diff back — the real y-protocols path.
		const remoteDoc = new Y.Doc({ gc: true });
		Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(doc));
		const remoteArr = remoteDoc.getArray<{
			key: string;
			val: Stored;
			ts: number;
		}>('table:notes');
		const remoteYkv = new YKeyValueLww<Stored>(remoteArr);
		const stateVectorBefore = Y.encodeStateVector(doc);
		const plan = remotePlan(ykv.size, editCount);
		remoteDoc.transact(() => {
			for (const edit of plan) {
				const row = remoteYkv.get(edit.id);
				if (row) remoteYkv.set(edit.id, { ...row, [edit.field]: edit.value });
			}
		});
		const diff = Y.encodeStateAsUpdate(remoteDoc, stateVectorBefore);
		const t0 = now();
		Y.applyUpdate(doc, diff);
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
