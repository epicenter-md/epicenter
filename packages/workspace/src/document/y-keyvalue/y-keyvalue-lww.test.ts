/**
 * YKeyValueLww Tests - Last-Write-Wins Conflict Resolution
 *
 * These tests verify timestamp-based last-write-wins semantics in `YKeyValueLww`
 * across local operations, caller-owned transactions, and multi-client synchronization.
 * They ensure deterministic winner selection by timestamp and convergence after sync.
 *
 * Key behaviors:
 * - Higher timestamps win conflicts regardless of merge ordering.
 * - Equal timestamps use final Y.Array position, both at construction and sync.
 * - Reads inside caller-owned Yjs transactions include local writes and deletes.
 * - Reconciliation preserves origins, event batching, and unchanged references.
 *
 * See also:
 * - `y-keyvalue.ts` for positional (rightmost-wins) alternative
 * - `__benchmarks__/conflict-resolution.bench.ts` for side-by-side behavioral comparison
 */
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import type { KvStoreChange } from './observable-kv-store.js';
import { YKeyValueLww, type YKeyValueLwwEntry } from './y-keyvalue-lww';

/**
 * Create the smallest useful LWW KV fixture.
 *
 * The single source of truth remains `YKeyValueLww`; this helper only removes
 * repeated Y.Doc and Y.Array wiring from tests that are asserting KV behavior,
 * not construction behavior.
 */
function setupKv<T = string>() {
	const ydoc = new Y.Doc({ guid: 'test' });
	const yarray = ydoc.getArray<YKeyValueLwwEntry<T>>('data');
	const kv = new YKeyValueLww(yarray);
	return { ydoc, yarray, kv };
}

/**
 * Create two docs that can exchange Yjs updates.
 *
 * Sync semantics belong to Yjs. Tests use this helper only when they need the
 * repeated two-doc boundary for conflict and convergence assertions.
 */
function setupSyncedArrays<T = string>(guid = 'shared') {
	const doc1 = new Y.Doc({ guid });
	const doc2 = new Y.Doc({ guid });
	return {
		doc1,
		doc2,
		array1: doc1.getArray<YKeyValueLwwEntry<T>>('data'),
		array2: doc2.getArray<YKeyValueLwwEntry<T>>('data'),
	};
}

/**
 * Apply each document's current update to the other document.
 *
 * This keeps sync direction consistent in every test that cares about
 * convergence, while leaving conflict resolution in the production KV class.
 */
function syncBoth(doc1: Y.Doc, doc2: Y.Doc): void {
	Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
	Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
}

describe('YKeyValueLww', () => {
	describe('Basic Operations', () => {
		test('get() reports stored values and undefined for absence', () => {
			const { kv } = setupKv();

			kv.set('foo', 'bar');

			expect(kv.get('foo')).toBe('bar');
			expect(kv.get('missing')).toBeUndefined();
			expect(kv.has('foo')).toBe(true);
			expect(kv.has('missing')).toBe(false);

			kv.delete('foo');
			expect(kv.get('foo')).toBeUndefined();
			expect(kv.has('foo')).toBe(false);
		});

		test('set overwrites existing value', () => {
			const { kv } = setupKv();

			kv.set('foo', 'first');
			kv.set('foo', 'second');
			expect(kv.get('foo')).toBe('second');
		});

		test('bulkSet inserts all entries', () => {
			const { kv } = setupKv();

			kv.bulkSet([
				{ key: 'foo', val: 'bar' },
				{ key: 'baz', val: 'qux' },
				{ key: 'zap', val: 'zip' },
			]);

			expect(kv.get('foo')).toBe('bar');
			expect(kv.get('baz')).toBe('qux');
			expect(kv.get('zap')).toBe('zip');
			expect(Array.from(kv.entries())).toHaveLength(3);
		});

		test('bulkSet updates existing entries', () => {
			const { yarray, kv } = setupKv();

			kv.set('foo', 'first');
			kv.bulkSet([
				{ key: 'foo', val: 'second' },
				{ key: 'bar', val: 'third' },
			]);

			expect(kv.get('foo')).toBe('second');
			expect(kv.get('bar')).toBe('third');
			expect(
				Array.from(kv.entries())
					.map((entry) => entry.key)
					.sort(),
			).toEqual(['bar', 'foo']);
			expect(
				yarray
					.toArray()
					.map((entry) => entry.key)
					.sort(),
			).toEqual(['bar', 'foo']);
		});

		test('bulkDelete removes all specified keys', () => {
			const { kv } = setupKv();

			kv.bulkSet([
				{ key: 'foo', val: 'bar' },
				{ key: 'baz', val: 'qux' },
				{ key: 'zap', val: 'zip' },
			]);
			kv.bulkDelete(['foo', 'zap']);

			expect(kv.get('foo')).toBeUndefined();
			expect(kv.get('zap')).toBeUndefined();
			expect(kv.get('baz')).toBe('qux');
			expect(Array.from(kv.entries()).map((entry) => entry.key)).toEqual([
				'baz',
			]);
		});

		test('bulkDelete is a no-op for missing keys', () => {
			const { yarray, kv } = setupKv();

			kv.bulkSet([
				{ key: 'foo', val: 'bar' },
				{ key: 'baz', val: 'qux' },
			]);
			const before = yarray.toArray();

			kv.bulkDelete(['missing', 'still-missing']);

			expect(kv.get('foo')).toBe('bar');
			expect(kv.get('baz')).toBe('qux');
			expect(yarray.toArray()).toEqual(before);
		});

		test('entries have timestamp field', () => {
			const { yarray, kv } = setupKv();

			kv.set('foo', 'bar');

			const entry = yarray.get(0);
			expect(entry.key).toBe('foo');
			expect(entry.val).toBe('bar');
			expect(typeof entry.ts).toBe('number');
			expect(entry.ts).toBeGreaterThan(0);
		});

		test('timestamps are monotonically increasing', () => {
			const { yarray, kv } = setupKv();

			kv.set('a', '1');
			kv.set('b', '2');
			kv.set('c', '3');

			const entries = yarray.toArray();
			const [firstEntry, secondEntry, thirdEntry] = entries;
			if (!firstEntry || !secondEntry || !thirdEntry) {
				throw new Error('expected three entries');
			}
			expect(firstEntry.ts).toBeLessThan(secondEntry.ts);
			expect(secondEntry.ts).toBeLessThan(thirdEntry.ts);
		});
	});

	describe('LWW Conflict Resolution', () => {
		test('higher timestamp wins regardless of sync order', () => {
			const { doc1, doc2, array1, array2 } = setupSyncedArrays();

			// Manually push entries with controlled timestamps
			// Client 1 writes with LOWER timestamp (earlier)
			array1.push([{ key: 'x', val: 'from-client-1-earlier', ts: 1000 }]);

			// Client 2 writes with HIGHER timestamp (later)
			array2.push([{ key: 'x', val: 'from-client-2-later', ts: 2000 }]);

			syncBoth(doc1, doc2);

			// Now create KV wrappers - they should resolve conflicts
			const kv1 = new YKeyValueLww(array1);
			const kv2 = new YKeyValueLww(array2);

			// Higher timestamp should win
			expect(kv1.get('x')).toBe('from-client-2-later');
			expect(kv2.get('x')).toBe('from-client-2-later');
		});

		test('convergence: both clients see same value after sync', () => {
			const cases = [
				{ ts1: 1000, ts2: 2000, expected: 'client-2-0' },
				{ ts1: 3000, ts2: 2000, expected: 'client-1-1' },
				{ ts1: 1500, ts2: 1501, expected: 'client-2-2' },
				{ ts1: 4000, ts2: 3999, expected: 'client-1-3' },
			] as const;

			for (const [index, { ts1, ts2, expected }] of cases.entries()) {
				const { doc1, doc2, array1, array2 } = setupSyncedArrays(
					`shared-${index}`,
				);

				array1.push([{ key: 'key', val: `client-1-${index}`, ts: ts1 }]);
				array2.push([{ key: 'key', val: `client-2-${index}`, ts: ts2 }]);

				syncBoth(doc1, doc2);

				const kv1 = new YKeyValueLww(array1);
				const kv2 = new YKeyValueLww(array2);

				expect(kv1.get('key')).toBe(kv2.get('key'));
				expect(kv1.get('key')).toBe(expected);
			}
		});
	});

	describe('Change Events', () => {
		test('emits add, update, and delete across a key lifecycle', () => {
			const { kv } = setupKv();
			const events: KvStoreChange<string>[] = [];
			kv.observe((changes) => {
				const change = changes.get('foo');
				if (change) events.push(change);
			});

			kv.set('foo', 'first');
			kv.set('foo', 'second');
			kv.delete('foo');

			expect(events).toEqual([
				{ action: 'add', newValue: 'first' },
				{ action: 'update', newValue: 'second' },
				{ action: 'delete' },
			]);
		});
	});

	describe('Equal Timestamp Tiebreaker', () => {
		test('equal timestamps fall back to positional ordering (rightmost wins)', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');

			// Push two entries with same timestamp
			yarray.push([{ key: 'x', val: 'first', ts: 1000 }]);
			yarray.push([{ key: 'x', val: 'second', ts: 1000 }]); // same ts, but rightmost

			const kv = new YKeyValueLww(yarray);

			// Rightmost should win when timestamps equal
			expect(kv.get('x')).toBe('second');
			expect(yarray.length).toBe(1); // Duplicate should be cleaned up
		});

		test('live conflicts choose the same rightmost winner as constructor hydration', () => {
			const { doc1, doc2, array1, array2 } = setupSyncedArrays();
			array1.push([{ key: 'x', val: 'client-1', ts: 1000 }]);
			array2.push([{ key: 'x', val: 'client-2', ts: 1000 }]);

			const mergedDoc = new Y.Doc();
			Y.applyUpdate(mergedDoc, Y.encodeStateAsUpdate(doc1));
			Y.applyUpdate(mergedDoc, Y.encodeStateAsUpdate(doc2));
			const mergedEntries = mergedDoc
				.getArray<YKeyValueLwwEntry<string>>('data')
				.toArray();
			const expected = mergedEntries.at(-1)?.val;

			const kv1 = new YKeyValueLww(array1);
			const kv2 = new YKeyValueLww(array2);
			syncBoth(doc1, doc2);

			expect(kv1.get('x')).toBe(expected);
			expect(kv2.get('x')).toBe(expected);
			expect(array1).toHaveLength(1);
			expect(array2).toHaveLength(1);
		});
	});

	describe('Resolution pipeline contracts', () => {
		test('nested transactions preserve the outer origin and emit once', () => {
			const { ydoc, kv } = setupKv();
			const outerOrigin = Symbol('outer');
			const innerOrigin = Symbol('inner');
			const batches: Array<{ changes: Map<string, unknown>; origin: unknown }> =
				[];
			kv.observe((changes, origin) => batches.push({ changes, origin }));

			ydoc.transact(() => {
				kv.set('a', 'first');
				ydoc.transact(() => kv.set('a', 'second'), innerOrigin);
				kv.set('b', 'value');
			}, outerOrigin);

			expect(batches).toHaveLength(1);
			expect(batches[0]?.origin).toBe(outerOrigin);
			expect([...(batches[0]?.changes.keys() ?? [])].sort()).toEqual([
				'a',
				'b',
			]);
		});

		test('remote updates emit their applyUpdate origin', () => {
			const { doc1, doc2, array1, array2 } = setupSyncedArrays();
			const kv1 = new YKeyValueLww(array1);
			const kv2 = new YKeyValueLww(array2);
			const remoteOrigin = Symbol('remote');
			const origins: unknown[] = [];
			kv2.observe((_changes, origin) => origins.push(origin));

			kv1.set('remote', 'value');
			Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1), remoteOrigin);

			expect(origins).toEqual([remoteOrigin]);
			expect(kv2.get('remote')).toBe('value');
		});

		test('a lower-timestamp remote loser emits nothing and keeps winner identity', () => {
			const { doc1, doc2, array1, array2 } = setupSyncedArrays();
			array1.push([{ key: 'x', val: 'winner', ts: 2000 }]);
			const kv1 = new YKeyValueLww(array1);
			const winner = kv1.map.get('x');
			let observerCalls = 0;
			kv1.observe(() => observerCalls++);

			array2.push([{ key: 'x', val: 'loser', ts: 1000 }]);
			Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2), Symbol('remote'));

			expect(kv1.map.get('x')).toBe(winner);
			expect(kv1.get('x')).toBe('winner');
			expect(array1).toHaveLength(1);
			expect(observerCalls).toBe(0);
		});

		test('conflict cleanup adds one private raw transaction but one public batch', () => {
			const { ydoc, yarray, kv } = setupKv();
			kv.set('x', 'old');
			const origin = Symbol('bulk-update');
			const rawOrigins: unknown[] = [];
			const publicOrigins: unknown[] = [];
			yarray.observe((_event, transaction) =>
				rawOrigins.push(transaction.origin),
			);
			kv.observe((_changes, transactionOrigin) =>
				publicOrigins.push(transactionOrigin),
			);

			ydoc.transact(() => kv.bulkSet([{ key: 'x', val: 'new' }]), origin);

			expect(publicOrigins).toEqual([origin]);
			expect(rawOrigins).toHaveLength(2);
			expect(rawOrigins[0]).toBe(origin);
			expect(typeof rawOrigins[1]).toBe('symbol');
		});

		test('constructor conflict cleanup keeps its origin-null raw transaction', () => {
			const ydoc = new Y.Doc();
			const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
			yarray.push([
				{ key: 'x', val: 'old', ts: 1 },
				{ key: 'x', val: 'new', ts: 2 },
			]);
			const origins: unknown[] = [];
			yarray.observe((_event, transaction) => origins.push(transaction.origin));

			const kv = new YKeyValueLww(yarray);

			expect(kv.get('x')).toBe('new');
			expect(origins).toEqual([null]);
		});

		test('unchanged entries keep their entry and value references through cleanup', () => {
			const { kv } = setupKv<{ label: string }>();
			const stableValue = { label: 'stable' };
			kv.bulkSet([
				{ key: 'stable', val: stableValue },
				{ key: 'changed', val: { label: 'old' } },
			]);
			const stableEntry = kv.map.get('stable');

			kv.bulkSet([{ key: 'changed', val: { label: 'new' } }]);

			expect(kv.map.get('stable')).toBe(stableEntry);
			expect(kv.get('stable')).toBe(stableValue);
		});

		test('bulk conflict cleanup keeps one entry per key and emits one batch', () => {
			const { yarray, kv } = setupKv<number>();
			const count = 1000;
			const initial = Array.from({ length: count }, (_, index) => ({
				key: `key-${index}`,
				val: index,
			}));
			kv.bulkSet(initial);
			const batches: Map<string, unknown>[] = [];
			kv.observe((changes) => batches.push(changes));

			kv.bulkSet(initial.map(({ key, val }) => ({ key, val: val + 1 })));

			expect(batches).toHaveLength(1);
			expect(batches[0]?.size).toBe(count);
			expect(yarray).toHaveLength(count);
			expect(kv.get('key-999')).toBe(1000);
		});

		test('bulkSet resolves several versions of one absent key in one pass', () => {
			const { yarray, kv } = setupKv();
			const actions: string[] = [];
			kv.observe((changes) => {
				const change = changes.get('x');
				if (change) actions.push(change.action);
			});

			kv.bulkSet([
				{ key: 'x', val: 'first' },
				{ key: 'x', val: 'second' },
				{ key: 'x', val: 'third' },
			]);

			expect(kv.get('x')).toBe('third');
			expect(yarray).toHaveLength(1);
			expect(actions).toEqual(['update']);
		});

		test('repeated writes to an absent key retain the update event contract', () => {
			const { ydoc, kv } = setupKv();
			const actions: string[] = [];
			kv.observe((changes) => {
				const change = changes.get('x');
				if (change) actions.push(change.action);
			});

			ydoc.transact(() => {
				kv.set('x', 'first');
				kv.set('x', 'second');
			});

			expect(actions).toEqual(['update']);
			expect(kv.get('x')).toBe('second');
		});

		test('bulk writes followed by delete leave an absent key absent', () => {
			const { ydoc, yarray, kv } = setupKv();
			const actions: string[] = [];
			kv.observe((changes) => {
				const change = changes.get('x');
				if (change) actions.push(change.action);
			});

			ydoc.transact(() => {
				kv.bulkSet([
					{ key: 'x', val: 'first' },
					{ key: 'x', val: 'second' },
				]);
				kv.delete('x');
			});

			expect(kv.get('x')).toBeUndefined();
			expect(yarray).toHaveLength(0);
			expect(actions).toEqual([]);
		});

		test('a remote set applied after a local delete in one transaction survives', () => {
			const { doc1, doc2, array1, array2 } = setupSyncedArrays();
			const kv1 = new YKeyValueLww(array1);
			const kv2 = new YKeyValueLww(array2);
			kv1.set('x', 'original');
			Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
			const doc1State = Y.encodeStateVector(doc1);
			kv2.set('x', 'remote');
			const remoteUpdate = Y.encodeStateAsUpdate(doc2, doc1State);
			const outerOrigin = Symbol('outer');
			const origins: unknown[] = [];
			kv1.observe((_changes, origin) => origins.push(origin));

			doc1.transact(() => {
				kv1.delete('x');
				Y.applyUpdate(doc1, remoteUpdate, Symbol('nested-remote'));
			}, outerOrigin);

			expect(kv1.get('x')).toBe('remote');
			expect(origins).toEqual([outerOrigin]);
		});

		const permutations = [
			{
				name: 'set-delete on an absent key stays absent without an event',
				initial: undefined,
				operations: ['set', 'delete'],
				expected: undefined,
				actions: [],
			},
			{
				name: 'set-set-delete on an absent key leaves no surviving write',
				initial: undefined,
				operations: ['set', 'set', 'delete'],
				expected: undefined,
				actions: [],
			},
			{
				name: 'set-delete-set on an absent key emits add for the final value',
				initial: undefined,
				operations: ['set', 'delete', 'set'],
				expected: 'value-1',
				actions: ['add'],
			},
			{
				name: 'delete-set on an existing key emits update',
				initial: 'initial',
				operations: ['delete', 'set'],
				expected: 'value-0',
				actions: ['update'],
			},
			{
				name: 'set-delete on an existing key emits delete',
				initial: 'initial',
				operations: ['set', 'delete'],
				expected: undefined,
				actions: ['delete'],
			},
			{
				name: 'delete-set-delete on an existing key emits delete',
				initial: 'initial',
				operations: ['delete', 'set', 'delete'],
				expected: undefined,
				actions: ['delete'],
			},
		] as const;

		for (const scenario of permutations) {
			test(scenario.name, () => {
				const { ydoc, yarray, kv } = setupKv();
				if (scenario.initial !== undefined) kv.set('x', scenario.initial);
				const actions: string[] = [];
				kv.observe((changes) => {
					const change = changes.get('x');
					if (change) actions.push(change.action);
				});

				let setIndex = 0;
				ydoc.transact(() => {
					for (const operation of scenario.operations) {
						if (operation === 'set') kv.set('x', `value-${setIndex++}`);
						else kv.delete('x');
					}
				});

				expect(kv.get('x')).toBe(scenario.expected);
				expect(actions).toEqual([...scenario.actions]);
				expect(
					yarray.toArray().filter((entry) => entry.key === 'x'),
				).toHaveLength(scenario.expected === undefined ? 0 : 1);
			});
		}
	});

	describe('Transaction-local reads', () => {
		/**
		 * When a caller opens a Yjs transaction, the Y.Array mutates
		 * immediately but the observer-backed map is not refreshed until the
		 * transaction closes. These tests cover the public read overlay: local
		 * writes and deletes are visible through get(), has(), and entries() during
		 * that transaction window.
		 */

		describe('writes inside caller-owned transactions', () => {
			test('get() returns each successive value', () => {
				const { ydoc, kv } = setupKv();

				const valuesDuringTransaction: Array<string | undefined> = [];

				ydoc.transact(() => {
					kv.set('foo', 'first');
					valuesDuringTransaction.push(kv.get('foo'));

					kv.set('foo', 'second');
					valuesDuringTransaction.push(kv.get('foo'));

					kv.set('foo', 'third');
					valuesDuringTransaction.push(kv.get('foo'));
				});

				expect(valuesDuringTransaction).toEqual(['first', 'second', 'third']);
				expect(kv.get('foo')).toBe('third');
			});
		});

		describe('deletes inside caller-owned transactions', () => {
			test('delete hides a pre-existing key from every read surface', () => {
				const { ydoc, kv } = setupKv();
				kv.set('foo', 'bar');

				ydoc.transact(() => {
					kv.delete('foo');
					expect(kv.get('foo')).toBeUndefined();
					expect(kv.has('foo')).toBe(false);
					expect([...kv.entries()]).toEqual([]);
				});

				expect(kv.get('foo')).toBeUndefined();
			});
		});

		describe('entries() during caller-owned transactions', () => {
			test('entries() yields both observer-indexed and transaction-local values', () => {
				const { ydoc, kv } = setupKv();

				// Set initial values (will be in map after transaction)
				kv.set('existing', 'old');

				const entriesDuringTransaction: Array<[string, string]> = [];

				ydoc.transact(() => {
					kv.set('new', 'value');

					for (const { key, val } of kv.entries()) {
						entriesDuringTransaction.push([key, val]);
					}
				});

				expect(entriesDuringTransaction).toContainEqual(['existing', 'old']);
				expect(entriesDuringTransaction).toContainEqual(['new', 'value']);
			});

			test('entries() does not yield duplicates', () => {
				const { ydoc, kv } = setupKv();

				kv.set('foo', 'old');

				let fooCount = 0;
				let valueDuringTransaction: string | undefined;

				ydoc.transact(() => {
					kv.set('foo', 'new');

					for (const { key, val } of kv.entries()) {
						if (key !== 'foo') continue;
						fooCount++;
						valueDuringTransaction = val;
					}
				});

				expect(fooCount).toBe(1);
				expect(valueDuringTransaction).toBe('new');
			});
		});

		describe('Sync with transaction-local writes', () => {
			test('remote sync during a caller-owned transaction is visible after it ends', () => {
				const { doc1, doc2, array1, array2 } = setupSyncedArrays();

				const kv1 = new YKeyValueLww(array1);
				const kv2 = new YKeyValueLww(array2);

				// kv1 sets a value
				kv1.set('foo', 'from-kv1');

				// kv2 makes a change while kv1's change is not yet synced
				doc2.transact(() => {
					kv2.set('bar', 'from-kv2');
					// Sync kv1's changes into kv2 during the caller-owned transaction.
					Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

					expect(kv2.get('bar')).toBe('from-kv2');
					// Remote synced values are in the Y.Array, but only local writes go
					// through the transaction-local overlay. Remote values become visible
					// after the observer runs at transaction close.
				});

				// After the transaction closes, both local and synced values are visible.
				expect(kv2.get('bar')).toBe('from-kv2');
				expect(kv2.get('foo')).toBe('from-kv1');
			});
		});

		describe('Edge cases', () => {
			test('undefined value reads as absent through get and has', () => {
				const { kv } = setupKv<string | undefined>();

				kv.set('foo', undefined);
				expect(kv.get('foo')).toBeUndefined();
				expect(kv.has('foo')).toBe(false);
			});

			test('mixed operations expose their latest state in a caller-owned transaction', () => {
				const { ydoc, kv } = setupKv();

				// Pre-populate
				kv.set('keep', 'original');
				kv.set('update', 'old');
				kv.set('delete', 'gone');

				ydoc.transact(() => {
					kv.set('new', 'added');
					kv.set('update', 'new');
					kv.delete('delete');

					expect(kv.get('keep')).toBe('original');
					expect(kv.get('update')).toBe('new');
					expect(kv.get('new')).toBe('added');
					// The transaction-local delete overlay hides the key immediately.
					expect(kv.has('delete')).toBe(false);
					expect(kv.get('delete')).toBeUndefined();
				});

				expect(kv.get('keep')).toBe('original');
				expect(kv.get('update')).toBe('new');
				expect(kv.get('new')).toBe('added');
				expect(kv.has('delete')).toBe(false);
			});

			test('double delete is idempotent', () => {
				const { ydoc, kv } = setupKv();

				kv.set('foo', 'bar');

				ydoc.transact(() => {
					kv.delete('foo');
					kv.delete('foo'); // second delete should be no-op
					expect(kv.has('foo')).toBe(false);
				});

				expect(kv.has('foo')).toBe(false);
				expect(kv.get('foo')).toBeUndefined();
			});

			test('entries skips transaction-local deletes', () => {
				const { ydoc, kv } = setupKv();

				kv.set('a', '1');
				kv.set('b', '2');
				kv.set('c', '3');

				let keysDuringTransaction: string[] = [];

				ydoc.transact(() => {
					kv.delete('b');
					keysDuringTransaction = Array.from(kv.entries()).map(
						(entry) => entry.key,
					);
				});

				expect(keysDuringTransaction).not.toContain('b');
				expect(keysDuringTransaction).toContain('a');
				expect(keysDuringTransaction).toContain('c');
			});

			test('delete non-existent key is no-op', () => {
				const { ydoc, kv } = setupKv();

				// Delete a key that was never set: should not throw
				kv.delete('never-existed');
				expect(kv.has('never-existed')).toBe(false);
				expect(kv.get('never-existed')).toBeUndefined();

				// The operation is also a no-op inside a caller-owned transaction.
				ydoc.transact(() => {
					kv.delete('also-never-existed');
					expect(kv.has('also-never-existed')).toBe(false);
				});
			});

			test('both clients delete same key', () => {
				const { doc1, doc2, array1, array2 } = setupSyncedArrays('test');
				const kv1 = new YKeyValueLww(array1);
				const kv2 = new YKeyValueLww(array2);

				// Both clients have the key
				kv1.set('foo', 'shared');
				Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
				expect(kv2.get('foo')).toBe('shared');

				// Both delete independently
				kv1.delete('foo');
				kv2.delete('foo');

				// Sync both ways
				Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
				Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

				// Both should see it deleted
				expect(kv1.has('foo')).toBe(false);
				expect(kv2.has('foo')).toBe(false);
			});

			test('local set then remote delete of same key', () => {
				const { doc1, doc2, array1, array2 } = setupSyncedArrays('test');
				const kv1 = new YKeyValueLww(array1);
				const kv2 = new YKeyValueLww(array2);

				// Both clients have the key
				kv1.set('foo', 'original');
				Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

				// Client 1 updates the key (gets higher timestamp)
				kv1.set('foo', 'updated');

				// Client 2 deletes the key
				kv2.delete('foo');

				// Sync both ways
				Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
				Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

				// Client 1's set had a higher timestamp, so it should win over client 2's delete.
				// After sync, both should converge to the same value.
				expect(kv1.get('foo')).toBe(kv2.get('foo'));
				// The set (with higher ts) wins over the delete
				expect(kv1.get('foo')).toBe('updated');
			});
		});
	});
});
