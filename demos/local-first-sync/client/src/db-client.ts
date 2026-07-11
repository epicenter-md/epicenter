/**
 * Page-side handle to the database worker: RPC + change subscription.
 * `onChange` is the reactivity root — the demo's `fromTable` equivalent
 * subscribes here, so UI updates are invalidation-driven, never polled.
 */

import type { AcceptedOp, Op, OpInput } from '../../shared/protocol';
import DbWorker from './db-worker?worker';

export type NoteRecord = {
	id: string;
	title: string | null;
	pinned: number | null;
	updatedAt: string | null;
	subtitle?: string | null;
	extra: string;
};

export function createDbClient() {
	const worker = new DbWorker();
	let nextId = 1;
	const pending = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	const changeListeners = new Set<(scope: string) => void>();

	worker.addEventListener('message', (event: MessageEvent) => {
		const data = event.data as {
			id?: number;
			result?: unknown;
			error?: string;
			type?: string;
			scope?: string;
		};
		if (data.type === 'change') {
			for (const listener of changeListeners) listener(data.scope ?? '');
			return;
		}
		if (data.id === undefined) return;
		const entry = pending.get(data.id);
		if (!entry) return;
		pending.delete(data.id);
		if (data.error !== undefined) entry.reject(new Error(data.error));
		else entry.resolve(data.result);
	});

	function call<T>(method: string, ...args: unknown[]): Promise<T> {
		const id = nextId++;
		return new Promise<T>((resolve, reject) => {
			pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			worker.postMessage({ id, method, args });
		});
	}

	return {
		open: (opts: { file: string; appVersion: 1 | 2; clientId: string }) =>
			call<{ knownFields: string[] }>('open', opts),
		write: (op: OpInput) => call<{ opId: string }>('write', op),
		applyRemote: (opts: { ops: AcceptedOp[]; cursor: number }) =>
			call<{ applied: number }>('applyRemote', opts),
		outbox: () => call<{ idx: number; op: Op }[]>('outbox'),
		clearOutbox: (upTo: number) => call('clearOutbox', { upTo }),
		cursor: () => call<{ cursor: number }>('cursor'),
		listNotes: () => call<NoteRecord[]>('listNotes'),
		getNote: (id: string) => call<NoteRecord | null>('getNote', { id }),
		docUpdates: (docId: string) => call<string[]>('docUpdates', { docId }),
		counts: () => call<{ notes: number; outbox: number }>('counts'),
		exportRows: () => call<NoteRecord[]>('exportRows'),
		wipe: (file: string) => call('wipe', { file }),
		onChange(listener: (scope: string) => void): () => void {
			changeListeners.add(listener);
			return () => changeListeners.delete(listener);
		},
	};
}

export type DbClient = ReturnType<typeof createDbClient>;
