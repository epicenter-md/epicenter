import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { attachRecords, type RecordsHandle } from './attach-records.js';

/** A message-shaped value: the per-id JSON blob this layout exists to hold. */
type Message = {
	id: string;
	role: 'user' | 'assistant';
	parts: Array<{ type: 'text'; text: string }>;
};

function message(id: string, text: string): Message {
	return { id, role: 'user', parts: [{ type: 'text', text }] };
}

/**
 * Read a value by key through the only read the handle exposes, `entries()`.
 * The handle deliberately omits `get`; tests read the same way its consumer does.
 */
function read(store: RecordsHandle<Message>, key: string): Message | undefined {
	for (const entry of store.entries()) if (entry.key === key) return entry.val;
	return undefined;
}

/** Copy every update from `source` into `target`, the way sync would. */
function sync(source: Y.Doc, target: Y.Doc): void {
	Y.applyUpdate(target, Y.encodeStateAsUpdate(source));
}

describe('attachRecords', () => {
	test('round-trips whole JSON values by key', () => {
		const ydoc = new Y.Doc();
		const store = attachRecords<Message>(ydoc);

		expect(read(store, 'm1')).toBeUndefined();

		const m1 = message('m1', '你好');
		store.set('m1', m1);

		expect(read(store, 'm1')).toEqual(m1);
		expect([...store.entries()]).toHaveLength(1);
	});

	test('entries walks every stored value', () => {
		const ydoc = new Y.Doc();
		const store = attachRecords<Message>(ydoc);
		store.set('m1', message('m1', 'a'));
		store.set('m2', message('m2', 'b'));

		const byId = new Map(
			[...store.entries()].map((entry) => [entry.key, entry.val]),
		);
		expect(byId.size).toBe(2);
		expect(byId.get('m1')).toEqual(message('m1', 'a'));
		expect(byId.get('m2')).toEqual(message('m2', 'b'));
	});

	test('observe fires on local writes', () => {
		const ydoc = new Y.Doc();
		const store = attachRecords<Message>(ydoc);

		let fires = 0;
		const stop = store.observe(() => {
			fires += 1;
		});
		store.set('m1', message('m1', 'a'));
		store.set('m2', message('m2', 'b'));
		stop();
		store.set('m3', message('m3', 'c'));

		expect(fires).toBe(2);
	});

	test('a stored value syncs to another doc', () => {
		const docA = new Y.Doc();
		const storeA = attachRecords<Message>(docA);
		storeA.set('m1', message('m1', '你好'));

		const docB = new Y.Doc();
		const storeB = attachRecords<Message>(docB);
		sync(docA, docB);

		expect(read(storeB, 'm1')).toEqual(message('m1', '你好'));
	});

	test('concurrent writes to one key converge last-write-wins', () => {
		const docA = new Y.Doc();
		const storeA = attachRecords<Message>(docA);
		const docB = new Y.Doc();
		const storeB = attachRecords<Message>(docB);

		storeA.set('m1', message('m1', 'from A'));
		sync(docA, docB);

		// B writes after seeing A's entry, so B adopts A's clock and wins.
		storeB.set('m1', message('m1', 'from B'));
		sync(docB, docA);

		expect(read(storeA, 'm1')).toEqual(message('m1', 'from B'));
		expect(read(storeB, 'm1')).toEqual(message('m1', 'from B'));
	});

	test('destroying the doc disposes the store without throwing', () => {
		const ydoc = new Y.Doc();
		const store = attachRecords<Message>(ydoc);
		store.set('m1', message('m1', 'a'));

		expect(() => ydoc.destroy()).not.toThrow();
	});
});
