/**
 * YKeyValueLww Tests - Last-Write-Wins Conflict Resolution
 *
 * These tests verify that YKeyValueLww correctly implements timestamp-based
 * conflict resolution, where higher timestamps always win regardless of sync order.
 *
 * See also:
 * - `y-keyvalue.ts` for positional (rightmost-wins) alternative
 * - `y-keyvalue-comparison.test.ts` for side-by-side behavioral comparison
 */
import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { YKeyValueLww, type YKeyValueLwwEntry } from './y-keyvalue-lww';

describe('YKeyValueLww', () => {
	describe('Basic Operations', () => {
		test('set and get work correctly', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
			const kv = new YKeyValueLww(yarray);

			kv.set('foo', 'bar');
			expect(kv.get('foo')).toBe('bar');
		});

		test('set overwrites existing value', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
			const kv = new YKeyValueLww(yarray);

			kv.set('foo', 'first');
			kv.set('foo', 'second');
			expect(kv.get('foo')).toBe('second');
		});

		test('delete removes value', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
			const kv = new YKeyValueLww(yarray);

			kv.set('foo', 'bar');
			kv.delete('foo');
			expect(kv.get('foo')).toBeUndefined();
			expect(kv.has('foo')).toBe(false);
		});

		test('entries have timestamp field', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
			const kv = new YKeyValueLww(yarray);

			kv.set('foo', 'bar');

			const entry = yarray.get(0);
			expect(entry.key).toBe('foo');
			expect(entry.val).toBe('bar');
			expect(typeof entry.ts).toBe('number');
			expect(entry.ts).toBeGreaterThan(0);
		});

		test('timestamps are monotonically increasing', () => {
			const ydoc = new Y.Doc({ guid: 'test' });
			const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
			const kv = new YKeyValueLww(yarray);

			kv.set('a', '1');
			kv.set('b', '2');
			kv.set('c', '3');

			const entries = yarray.toArray();
			expect(entries[0]!.ts).toBeLessThan(entries[1]!.ts);
			expect(entries[1]!.ts).toBeLessThan(entries[2]!.ts);
		});
	});

	describe('LWW Conflict Resolution', () => {
		test('higher timestamp wins regardless of sync order', () => {
			// Create two docs that will sync
			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const array1 = doc1.getArray<YKeyValueLwwEntry<string>>('data');
			const array2 = doc2.getArray<YKeyValueLwwEntry<string>>('data');

			// Manually push entries with controlled timestamps
			// Client 1 writes with LOWER timestamp (earlier)
			array1.push([{ key: 'x', val: 'from-client-1-earlier', ts: 1000 }]);

			// Client 2 writes with HIGHER timestamp (later)
			array2.push([{ key: 'x', val: 'from-client-2-later', ts: 2000 }]);

			// Sync in both directions
			Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
			Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

			// Now create KV wrappers - they should resolve conflicts
			const kv1 = new YKeyValueLww(array1);
			const kv2 = new YKeyValueLww(array2);

			// Higher timestamp should win
			expect(kv1.get('x')).toBe('from-client-2-later');
			expect(kv2.get('x')).toBe('from-client-2-later');
		});

		test('later edit wins over earlier edit (LWW semantics)', () => {
			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const array1 = doc1.getArray<YKeyValueLwwEntry<string>>('data');
			const array2 = doc2.getArray<YKeyValueLwwEntry<string>>('data');

			// Manually push entries with CONTROLLED timestamps to test LWW
			// Client 1 writes with LOWER timestamp (earlier edit)
			array1.push([{ key: 'doc', val: 'edit-from-client-1', ts: 1000 }]);

			// Client 2 writes with HIGHER timestamp (later edit)
			array2.push([{ key: 'doc', val: 'edit-from-client-2', ts: 2000 }]);

			// Sync both directions
			Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
			Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

			// Create KV wrappers - they should resolve conflicts using timestamps
			const kv1 = new YKeyValueLww(array1);
			const kv2 = new YKeyValueLww(array2);

			// Higher timestamp (2000) should win
			expect(kv1.get('doc')).toBe('edit-from-client-2');
			expect(kv2.get('doc')).toBe('edit-from-client-2');
		});

		test('convergence: both clients see same value after sync', () => {
			const results: { value: string; ts1: number; ts2: number }[] = [];

			for (let i = 0; i < 10; i++) {
				const doc1 = new Y.Doc({ guid: `shared-${i}` });
				const doc2 = new Y.Doc({ guid: `shared-${i}` });

				const array1 = doc1.getArray<YKeyValueLwwEntry<string>>('data');
				const array2 = doc2.getArray<YKeyValueLwwEntry<string>>('data');

				// Manually insert with controlled timestamps to test ordering
				const ts1 = 1000 + Math.random() * 1000;
				const ts2 = 1000 + Math.random() * 1000;

				array1.push([{ key: 'key', val: `client-1-${i}`, ts: ts1 }]);
				array2.push([{ key: 'key', val: `client-2-${i}`, ts: ts2 }]);

				// Sync
				Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));
				Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));

				// Create KV wrappers
				const kv1 = new YKeyValueLww(array1);
				const kv2 = new YKeyValueLww(array2);

				// Must converge
				expect(kv1.get('key')).toBe(kv2.get('key'));

				// Higher timestamp should win
				const expectedWinner = ts1 > ts2 ? `client-1-${i}` : `client-2-${i}`;
				expect(kv1.get('key')).toBe(expectedWinner);

				results.push({ value: kv1.get('key')!, ts1, ts2 });
			}

			console.log('LWW convergence results:', results);
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

	describe('Single-Writer Architecture', () => {
		/**
		 * These tests verify the single-writer architecture where:
		 * - set() writes to `pending` and Y.Array, but NOT to `map`
		 * - Observer is the sole writer to `map` and clears `pending` after processing
		 * - get()/has() check `pending` first, then `map`
		 * - entries() yields from both pending and map
		 */

		describe('Batch operations with nested reads', () => {
			test('get() returns value set in same batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

				let valueInBatch: string | undefined;

				ydoc.transact(() => {
					kv.set('foo', 'bar');
					valueInBatch = kv.get('foo');
				});

				expect(valueInBatch).toBe('bar');
				expect(kv.get('foo')).toBe('bar'); // Still works after batch
			});

			test('has() returns true for key set in same batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

				let hasInBatch: boolean = false;

				ydoc.transact(() => {
					kv.set('foo', 'bar');
					hasInBatch = kv.has('foo');
				});

				expect(hasInBatch).toBe(true);
			});

			test('multiple updates to same key in batch - final value wins', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

				const valuesInBatch: string[] = [];

				ydoc.transact(() => {
					kv.set('foo', 'first');
					valuesInBatch.push(kv.get('foo')!);

					kv.set('foo', 'second');
					valuesInBatch.push(kv.get('foo')!);

					kv.set('foo', 'third');
					valuesInBatch.push(kv.get('foo')!);
				});

				expect(valuesInBatch).toEqual(['first', 'second', 'third']);
				expect(kv.get('foo')).toBe('third');
			});

			test('get() returns updated value when updating existing key in batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

				// Set initial value outside batch
				kv.set('foo', 'initial');

				let valueInBatch: string | undefined;

				ydoc.transact(() => {
					kv.set('foo', 'updated');
					valueInBatch = kv.get('foo');
				});

				expect(valueInBatch).toBe('updated');
				expect(kv.get('foo')).toBe('updated');
			});
		});

		describe('Batch with deletes', () => {
			test('delete() removes key set in same batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

				let hasAfterDelete: boolean = true;

				ydoc.transact(() => {
					kv.set('foo', 'bar');
					kv.delete('foo');
					hasAfterDelete = kv.has('foo');
				});

				// During batch: pending was cleared by delete(), map doesn't have it yet
				expect(hasAfterDelete).toBe(false);

				// After batch: delete() now correctly removes the yarray entry even for
				// keys that were set (pending-only) in the same transaction
				expect(kv.has('foo')).toBe(false);
			});

			test('set() after delete() in same batch restores key', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

				// Set initial value
				kv.set('foo', 'initial');

				let valueInBatch: string | undefined;

				ydoc.transact(() => {
					kv.delete('foo');
					kv.set('foo', 'restored');
					valueInBatch = kv.get('foo');
				});

				expect(valueInBatch).toBe('restored');
				expect(kv.get('foo')).toBe('restored');
			});

			test('delete() on pre-existing key during batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

				kv.set('foo', 'bar');
				expect(kv.has('foo')).toBe(true);

				ydoc.transact(() => {
					kv.delete('foo');
					// During batch, map still has old value until observer fires
					// But has() checks pending first (which was cleared)
				});

				expect(kv.has('foo')).toBe(false);
			});
		});

		describe('entries() iterator', () => {
			test('entries() yields pending values during batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

				const keysInBatch: string[] = [];

				ydoc.transact(() => {
					kv.set('a', '1');
					kv.set('b', '2');
					kv.set('c', '3');

					for (const [key] of kv.entries()) {
						keysInBatch.push(key);
					}
				});

				expect(keysInBatch.sort()).toEqual(['a', 'b', 'c']);
			});

			test('entries() yields both pending and map values', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

				// Set initial values (will be in map after transaction)
				kv.set('existing', 'old');

				const entriesInBatch: Array<[string, string]> = [];

				ydoc.transact(() => {
					kv.set('new', 'value');

					for (const [key, entry] of kv.entries()) {
						entriesInBatch.push([key, entry.val]);
					}
				});

				expect(entriesInBatch).toContainEqual(['existing', 'old']);
				expect(entriesInBatch).toContainEqual(['new', 'value']);
			});

			test('entries() prefers pending over map for same key', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

				kv.set('foo', 'old');

				let valueInBatch: string | undefined;

				ydoc.transact(() => {
					kv.set('foo', 'new');

					for (const [key, entry] of kv.entries()) {
						if (key === 'foo') valueInBatch = entry.val;
					}
				});

				expect(valueInBatch).toBe('new');
			});

			test('entries() does not yield duplicates', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

				kv.set('foo', 'old');

				let fooCount = 0;

				ydoc.transact(() => {
					kv.set('foo', 'new');

					for (const [key] of kv.entries()) {
						if (key === 'foo') fooCount++;
					}
				});

				expect(fooCount).toBe(1);
			});
		});

		describe('Pending cleanup', () => {
			test('pending is cleared after transaction ends', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

				ydoc.transact(() => {
					kv.set('foo', 'bar');
					// During transaction, foo is in pending
				});

				// After transaction, observer has fired and cleared pending
				// We can't directly access pending, but we can verify behavior
				// by checking that map has the value
				expect(kv.get('foo')).toBe('bar');
				expect(kv.map.has('foo')).toBe(true);
			});

			test('multiple batches work correctly', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

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
			test('observer fires once per batch, not per set()', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

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

			test('observer receives all changes from batch', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

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

		describe('Sync with pending values', () => {
			test('remote sync during batch: synced values visible after batch ends', () => {
				const doc1 = new Y.Doc({ guid: 'shared' });
				const doc2 = new Y.Doc({ guid: 'shared' });

				const array1 = doc1.getArray<YKeyValueLwwEntry<string>>('data');
				const array2 = doc2.getArray<YKeyValueLwwEntry<string>>('data');

				const kv1 = new YKeyValueLww(array1);
				const kv2 = new YKeyValueLww(array2);

				// kv1 sets a value
				kv1.set('foo', 'from-kv1');

				// kv2 makes a change while kv1's change is not yet synced
				doc2.transact(() => {
					kv2.set('bar', 'from-kv2');
					// Sync kv1's changes into kv2 during the batch
					Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

					// During batch: local pending values are visible
					expect(kv2.get('bar')).toBe('from-kv2');
					// Remote synced values are in yarray but observer hasn't updated map yet
					// So they won't be visible via get() until batch ends
				});

				// After batch: both local and synced values are visible
				expect(kv2.get('bar')).toBe('from-kv2');
				expect(kv2.get('foo')).toBe('from-kv1');
			});

			test('LWW still works with pending entries', () => {
				const doc1 = new Y.Doc({ guid: 'shared' });
				const doc2 = new Y.Doc({ guid: 'shared' });

				const array1 = doc1.getArray<YKeyValueLwwEntry<string>>('data');
				const array2 = doc2.getArray<YKeyValueLwwEntry<string>>('data');

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
			test('set() with undefined value', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray =
					ydoc.getArray<YKeyValueLwwEntry<string | undefined>>('data');
				const kv = new YKeyValueLww(yarray);

				kv.set('foo', undefined);
				expect(kv.has('foo')).toBe(true);
				expect(kv.get('foo')).toBeUndefined();
			});

			test('rapid set/get cycles', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<number>>('data');
				const kv = new YKeyValueLww(yarray);

				for (let i = 0; i < 100; i++) {
					kv.set('counter', i);
					expect(kv.get('counter')).toBe(i);
				}

				expect(kv.get('counter')).toBe(99);
			});

			test('batch with mixed operations on multiple keys', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

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
					// Note: has('delete') returns true during batch because delete() only
					// removes from pending and deletes from yarray - map still has the old
					// value until observer fires. This is a known limitation.
					// The delete IS recorded in yarray, so after batch it will be gone.
				});

				expect(kv.get('keep')).toBe('original');
				expect(kv.get('update')).toBe('new');
				expect(kv.get('new')).toBe('added');
				expect(kv.has('delete')).toBe(false);
			});

			test('delete during batch: has() returns true until batch ends (known limitation)', () => {
				const ydoc = new Y.Doc({ guid: 'test' });
				const yarray = ydoc.getArray<YKeyValueLwwEntry<string>>('data');
				const kv = new YKeyValueLww(yarray);

				kv.set('foo', 'bar');

				let hasDuringBatch: boolean = false;

				ydoc.transact(() => {
					kv.delete('foo');
					// Known limitation: has() still returns true during batch
					// because map hasn't been updated yet (observer hasn't fired)
					hasDuringBatch = kv.has('foo');
				});

				// During batch, has() incorrectly returns true (reads from stale map)
				expect(hasDuringBatch).toBe(true);
				// After batch, correctly returns false
				expect(kv.has('foo')).toBe(false);
			});
		});
	});
});
