/**
 * YKeyValueLww Tests - Last-Write-Wins Conflict Resolution
 *
 * These tests verify timestamp-based last-write-wins semantics in `YKeyValueLww`
 * across local operations, caller-owned transactions, and multi-client synchronization.
 * They ensure deterministic winner selection by timestamp and convergence after sync.
 *
 * Key behaviors:
 * - Higher timestamps win conflicts regardless of merge ordering.
 * - Reads inside caller-owned Yjs transactions include local writes and deletes.
 *
 * See also:
 * - `y-keyvalue.ts` for positional (rightmost-wins) alternative
 * - `__benchmarks__/conflict-resolution.bench.ts` for side-by-side behavioral comparison
 */
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
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
		test('set stores value and get retrieves it', () => {
			const { kv } = setupKv();

			kv.set('foo', 'bar');
			expect(kv.get('foo')).toBe('bar');
		});

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

		test('delete removes value', () => {
			const { kv } = setupKv();

			kv.set('foo', 'bar');
			kv.delete('foo');
			expect(kv.get('foo')).toBeUndefined();
			expect(kv.has('foo')).toBe(false);
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
		test('fires add event for new key', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
			const kv = new YKeyValueLww(yarray);

			const events: Array<{ key: string; action: string }> = [];
			kv.observe((changes) => {
				for (const [key, change] of changes) {
					events.push({ key, action: change.action });
				}
			});

			kv.set('foo', 'bar');
			expect(events).toEqual([{ key: 'foo', action: 'add' }]);
		});

		test('fires update event when value changes', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
			const kv = new YKeyValueLww(yarray);

			kv.set('foo', 'first');

			const events: Array<{ key: string; action: string }> = [];
			kv.observe((changes) => {
				for (const [key, change] of changes) {
					events.push({ key, action: change.action });
				}
			});

			kv.set('foo', 'second');
			expect(events).toEqual([{ key: 'foo', action: 'update' }]);
		});

		test('fires delete event when key removed', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
			const kv = new YKeyValueLww(yarray);

			kv.set('foo', 'bar');

			const events: Array<{ key: string; action: string }> = [];
			kv.observe((changes) => {
				for (const [key, change] of changes) {
					events.push({ key, action: change.action });
				}
			});

			kv.delete('foo');
			expect(events).toEqual([{ key: 'foo', action: 'delete' }]);
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
			test('get() returns a value set earlier', () => {
				const { ydoc, kv } = setupKv();

				let valueDuringTransaction: string | undefined;

				ydoc.transact(() => {
					kv.set('foo', 'bar');
					valueDuringTransaction = kv.get('foo');
				});

				expect(valueDuringTransaction).toBe('bar');
				// The value remains visible after the observer-backed map catches up.
				expect(kv.get('foo')).toBe('bar');
			});

			test('has() returns true for a key set earlier', () => {
				const { ydoc, kv } = setupKv();

				let hasDuringTransaction: boolean = false;

				ydoc.transact(() => {
					kv.set('foo', 'bar');
					hasDuringTransaction = kv.has('foo');
				});

				expect(hasDuringTransaction).toBe(true);
			});

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

			test('get() returns an updated value for an existing key', () => {
				const { ydoc, kv } = setupKv();

				// Set the initial value before the caller-owned transaction.
				kv.set('foo', 'initial');

				let valueDuringTransaction: string | undefined;

				ydoc.transact(() => {
					kv.set('foo', 'updated');
					valueDuringTransaction = kv.get('foo');
				});

				expect(valueDuringTransaction).toBe('updated');
				expect(kv.get('foo')).toBe('updated');
			});
		});

		describe('deletes inside caller-owned transactions', () => {
			test('delete() removes a key set earlier', () => {
				const { ydoc, kv } = setupKv();

				let hasAfterDelete: boolean = true;

				ydoc.transact(() => {
					kv.set('foo', 'bar');
					kv.delete('foo');
					hasAfterDelete = kv.has('foo');
				});

				expect(hasAfterDelete).toBe(false);

				// After the transaction closes, the observer has caught up and the key
				// remains absent.
				expect(kv.has('foo')).toBe(false);
			});

			test('set() after delete() restores the key', () => {
				const { ydoc, kv } = setupKv();

				// Set initial value
				kv.set('foo', 'initial');

				let valueDuringTransaction: string | undefined;

				ydoc.transact(() => {
					kv.delete('foo');
					kv.set('foo', 'restored');
					valueDuringTransaction = kv.get('foo');
				});

				expect(valueDuringTransaction).toBe('restored');
				expect(kv.get('foo')).toBe('restored');
			});

			test('delete() hides a pre-existing key immediately', () => {
				const { ydoc, kv } = setupKv();

				kv.set('foo', 'bar');
				expect(kv.has('foo')).toBe(true);

				ydoc.transact(() => {
					kv.delete('foo');
					expect(kv.has('foo')).toBe(false);
				});

				// After the transaction closes, the observer-backed map agrees.
				expect(kv.has('foo')).toBe(false);
			});
		});

		describe('entries() during caller-owned transactions', () => {
			test('entries() yields values set earlier', () => {
				const { ydoc, kv } = setupKv();

				const keysDuringTransaction: string[] = [];

				ydoc.transact(() => {
					kv.set('a', '1');
					kv.set('b', '2');
					kv.set('c', '3');

					for (const { key } of kv.entries()) {
						keysDuringTransaction.push(key);
					}
				});

				expect(keysDuringTransaction.sort()).toEqual(['a', 'b', 'c']);
			});

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

			test('entries() prefers transaction-local value over observer-indexed value for same key', () => {
				const { ydoc, kv } = setupKv();

				kv.set('foo', 'old');

				let valueDuringTransaction: string | undefined;

				ydoc.transact(() => {
					kv.set('foo', 'new');

					for (const { key, val } of kv.entries()) {
						if (key === 'foo') valueDuringTransaction = val;
					}
				});

				expect(valueDuringTransaction).toBe('new');
			});

			test('entries() does not yield duplicates', () => {
				const { ydoc, kv } = setupKv();

				kv.set('foo', 'old');

				let fooCount = 0;

				ydoc.transact(() => {
					kv.set('foo', 'new');

					for (const { key } of kv.entries()) {
						if (key === 'foo') fooCount++;
					}
				});

				expect(fooCount).toBe(1);
			});
		});

		describe('overlay cleanup', () => {
			test('multiple transactions preserve prior keys and apply updates', () => {
				const { ydoc, kv } = setupKv();

				ydoc.transact(() => {
					kv.set('a', '1');
					kv.set('b', '2');
				});

				expect(kv.get('a')).toBe('1');
				expect(kv.get('b')).toBe('2');

				ydoc.transact(() => {
					kv.set('c', '3');
					kv.set('a', 'updated');
				});

				expect(kv.get('a')).toBe('updated');
				expect(kv.get('b')).toBe('2');
				expect(kv.get('c')).toBe('3');
			});
		});

		describe('Observer behavior', () => {
			test('observer fires once per caller-owned transaction, not per set()', () => {
				const { ydoc, kv } = setupKv();

				let observerCallCount = 0;
				kv.observe(() => {
					observerCallCount++;
				});

				ydoc.transact(() => {
					kv.set('a', '1');
					kv.set('b', '2');
					kv.set('c', '3');
				});

				expect(observerCallCount).toBe(1);
			});

			test('observer receives all changes from a caller-owned transaction', () => {
				const { ydoc, kv } = setupKv();

				const changedKeys: string[] = [];
				kv.observe((changes) => {
					for (const [key] of changes) {
						changedKeys.push(key);
					}
				});

				ydoc.transact(() => {
					kv.set('a', '1');
					kv.set('b', '2');
					kv.set('c', '3');
				});

				expect(changedKeys.sort()).toEqual(['a', 'b', 'c']);
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

			test('LWW conflict resolution still works with transaction-local writes', () => {
				const { doc1, doc2, array1, array2 } = setupSyncedArrays();

				// Manually insert with controlled timestamps
				array1.push([{ key: 'x', val: 'old', ts: 1000 }]);

				const kv1 = new YKeyValueLww(array1);
				const kv2 = new YKeyValueLww(array2);

				// Sync initial state
				Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
				expect(kv2.get('x')).toBe('old');

				// kv2 updates with higher timestamp
				kv2.set('x', 'new'); // Will get ts > 1000

				// Sync both ways
				Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
				Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

				// Higher timestamp should win
				expect(kv1.get('x')).toBe('new');
				expect(kv2.get('x')).toBe('new');
			});
		});

		describe('Edge cases', () => {
			test('undefined value reads as absent through get and has', () => {
				const { kv } = setupKv<string | undefined>();

				kv.set('foo', undefined);
				expect(kv.get('foo')).toBeUndefined();
				expect(kv.has('foo')).toBe(false);
			});

			test('rapid set/get cycles always return the latest value', () => {
				const { kv } = setupKv<number>();

				for (let i = 0; i < 100; i++) {
					kv.set('counter', i);
					expect(kv.get('counter')).toBe(i);
				}

				expect(kv.get('counter')).toBe(99);
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

			test('delete then get returns undefined immediately', () => {
				const { ydoc, kv } = setupKv();

				kv.set('foo', 'bar');

				let valueDuringTransaction: string | undefined = 'not-cleared';

				ydoc.transact(() => {
					kv.delete('foo');
					valueDuringTransaction = kv.get('foo');
				});

				expect(valueDuringTransaction).toBeUndefined();
				expect(kv.get('foo')).toBeUndefined();
			});

			test('delete then set returns the new value immediately', () => {
				const { ydoc, kv } = setupKv();

				kv.set('foo', 'bar');

				let valueDuringTransaction: string | undefined;

				ydoc.transact(() => {
					kv.delete('foo');
					expect(kv.get('foo')).toBeUndefined();
					kv.set('foo', 'new');
					valueDuringTransaction = kv.get('foo');
				});

				expect(valueDuringTransaction).toBe('new');
				expect(kv.get('foo')).toBe('new');
				expect(kv.has('foo')).toBe(true);
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

			test('observer clears transaction-local delete overlay', () => {
				const { ydoc, kv } = setupKv();

				kv.set('foo', 'bar');

				ydoc.transact(() => {
					kv.delete('foo');
					expect(kv.has('foo')).toBe(false);
				});

				// After the transaction closes, the observer has cleared the delete overlay.
				// Verify by setting a new value: a sticky overlay would keep has() false.
				kv.set('foo', 'baz');
				expect(kv.has('foo')).toBe(true);
				expect(kv.get('foo')).toBe('baz');
			});

			test('set then delete leaves no sticky delete overlay', () => {
				const { ydoc, kv } = setupKv();

				// Set then delete in one transaction: the Y.Array entry is added and removed
				// before the observer runs.
				ydoc.transact(() => {
					kv.set('foo', 'bar');
					kv.delete('foo');
				});

				// After the transaction closes, the delete overlay should be clear.
				// A subsequent set verifies that the old delete no longer masks this key.
				kv.set('foo', 'new');
				expect(kv.has('foo')).toBe(true);
				expect(kv.get('foo')).toBe('new');
			});

			test('remote set after local delete is not masked by delete overlay', () => {
				const { doc1, doc2, array1, array2 } = setupSyncedArrays('test');
				const kv1 = new YKeyValueLww(array1);
				const kv2 = new YKeyValueLww(array2);

				// Both clients have the key
				kv1.set('foo', 'original');
				Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

				// Client 1 deletes
				kv1.delete('foo');
				expect(kv1.has('foo')).toBe(false);

				// Client 2 sets a new value (higher timestamp)
				kv2.set('foo', 'remote-value');

				// Sync client 2's update to client 1
				Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

				// Client 1 should see the remote value: the delete overlay must not mask it.
				expect(kv1.has('foo')).toBe(true);
				expect(kv1.get('foo')).toBe('remote-value');
			});

			test('get() returns the final value after set-delete-set', () => {
				const { ydoc, kv } = setupKv();

				kv.set('foo', 'initial');

				let finalGet: string | undefined;

				ydoc.transact(() => {
					kv.set('foo', 'first');
					kv.delete('foo');
					expect(kv.get('foo')).toBeUndefined();
					kv.set('foo', 'final');
					finalGet = kv.get('foo');
				});

				expect(finalGet).toBe('final');
				expect(kv.get('foo')).toBe('final');
				expect(kv.has('foo')).toBe(true);
			});

			test('get() returns undefined after delete-set-delete', () => {
				const { ydoc, kv } = setupKv();

				kv.set('foo', 'original');

				ydoc.transact(() => {
					kv.delete('foo');
					expect(kv.has('foo')).toBe(false);
					kv.set('foo', 'revived');
					expect(kv.get('foo')).toBe('revived');
					kv.delete('foo');
					expect(kv.has('foo')).toBe(false);
				});

				expect(kv.has('foo')).toBe(false);
				expect(kv.get('foo')).toBeUndefined();
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

			test('delete overlay wins after set then delete', () => {
				const { ydoc, kv } = setupKv();

				kv.set('foo', 'original');

				let valueDuringTransaction: string | undefined = 'sentinel';

				ydoc.transact(() => {
					// set() adds a write overlay and clears any delete overlay.
					kv.set('foo', 'updated');
					expect(kv.get('foo')).toBe('updated');

					// delete() clears the write overlay and adds a delete overlay.
					kv.delete('foo');
					valueDuringTransaction = kv.get('foo');
				});

				// During the transaction, the delete overlay should have taken precedence.
				expect(valueDuringTransaction).toBeUndefined();
				expect(kv.has('foo')).toBe(false);
			});

			test('remote add for different key does not clear unrelated delete overlay', () => {
				const { doc1, doc2, array1, array2 } = setupSyncedArrays('test');
				const kv1 = new YKeyValueLww(array1);
				const kv2 = new YKeyValueLww(array2);

				// Both clients have keys 'a' and 'b'
				kv1.set('a', '1');
				kv1.set('b', '2');
				Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

				// Client 1 deletes 'a'
				kv1.delete('a');
				expect(kv1.has('a')).toBe(false);

				// Client 2 adds a completely new key 'c'
				kv2.set('c', '3');

				// Sync client 2's update to client 1
				Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

				// 'a' should still be deleted: the remote add of 'c' should not affect it
				expect(kv1.has('a')).toBe(false);
				expect(kv1.get('a')).toBeUndefined();
				// 'c' should be visible
				expect(kv1.get('c')).toBe('3');
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
