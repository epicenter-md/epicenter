/**
 * The durable record, and the three things about it that are not obvious.
 *
 * Runs under bun with `fake-indexeddb` supplying `indexedDB`, the same way
 * `browser.test.ts` does. What these pin is the arithmetic and the ordering:
 * that a fold keeps what arrived while it ran, that a sequence never repeats
 * even across one, and that a rejecting store says so instead of losing work
 * in silence.
 */
import 'fake-indexeddb/auto';

import { describe, expect, test } from 'bun:test';
import { openDurableRecord } from './record.js';

const bytes = (...values: number[]) => new Uint8Array(values);
const sizedBytes = (length: number) => new Uint8Array(length).fill(7);

let counter = 0;
const freshName = () => `test/record/${(counter += 1)}`;

describe('a chain', () => {
	test('an unwritten document reads as empty, not as a failure', async () => {
		const record = await openDurableRecord({ name: freshName() });
		expect(await record.read('app')).toEqual([]);
		record.close();
	});

	test('reads back in the order it was appended', async () => {
		const record = await openDurableRecord({ name: freshName() });
		await record.read('app');
		await record.append('app', bytes(1));
		await record.append('app', bytes(2));
		await record.append('app', bytes(3));
		expect(await record.read('app')).toEqual([bytes(1), bytes(2), bytes(3)]);
		record.close();
	});

	test('documents do not see each other', async () => {
		const record = await openDurableRecord({ name: freshName() });
		await record.read('app');
		await record.read('notes/abc');
		await record.append('app', bytes(1));
		await record.append('notes/abc', bytes(2));
		expect(await record.read('app')).toEqual([bytes(1)]);
		expect(await record.read('notes/abc')).toEqual([bytes(2)]);
		record.close();
	});

	test('survives a close and reopen, which is the whole point of it', async () => {
		const name = freshName();
		const first = await openDurableRecord({ name });
		await first.read('app');
		await first.append('app', bytes(1));
		first.close();

		const second = await openDurableRecord({ name });
		expect(await second.read('app')).toEqual([bytes(1)]);
		second.close();
	});

	test('retiring forgets one document and leaves its neighbours', async () => {
		const record = await openDurableRecord({ name: freshName() });
		await record.read('app');
		await record.read('notes/abc');
		await record.append('app', bytes(1));
		await record.append('notes/abc', bytes(2));
		await record.retire('notes/abc');
		expect(await record.read('notes/abc')).toEqual([]);
		expect(await record.read('app')).toEqual([bytes(1)]);
		record.close();
	});
});

describe('folding', () => {
	test('replaces the chain it covers with one record', async () => {
		const record = await openDurableRecord({ name: freshName() });
		await record.read('app');
		await record.append('app', bytes(1));
		await record.append('app', bytes(2));
		await record.fold('app', () => bytes(9));
		expect(await record.read('app')).toEqual([bytes(9)]);
		record.close();
	});

	test('keeps what arrives after encode, which is the race a bound-less delete loses', async () => {
		const record = await openDurableRecord({ name: freshName() });
		await record.read('app');
		await record.append('app', bytes(1));
		// Appended after `encode` has already run, so these bytes are in no
		// folded state and sit above the bound. Sweeping the whole range instead
		// of the range captured before encoding would lose them silently.
		let late: Promise<void> | undefined;
		await record.fold('app', () => {
			const state = bytes(9);
			late = record.append('app', bytes(2));
			return state;
		});
		await late;
		expect(await record.read('app')).toContainEqual(bytes(2));
		record.close();
	});

	test('a sequence is never reused, not even across a fold', async () => {
		const name = freshName();
		const record = await openDurableRecord({ name });
		await record.read('app');
		await record.append('app', bytes(1));
		await record.fold('app', () => bytes(9));
		await record.append('app', bytes(3));
		// If the fold had reset the counter, this append would overwrite the
		// folded state at the same key and the chain would lose everything
		// before it.
		expect(await record.read('app')).toEqual([bytes(9), bytes(3)]);
		record.close();
	});

	test('touches only its own document', async () => {
		const record = await openDurableRecord({ name: freshName() });
		await record.read('app');
		await record.read('notes/abc');
		await record.append('app', bytes(1));
		await record.append('notes/abc', bytes(2));
		await record.append('notes/abc', bytes(3));
		// The range delete is the one line in this file that can reach a
		// neighbour, and nothing else in the suite exercises it.
		await record.fold('app', () => bytes(9));
		expect(await record.read('notes/abc')).toEqual([bytes(2), bytes(3)]);
		record.close();
	});

	test('is safe when nothing has been folded yet, and idempotent after', async () => {
		const record = await openDurableRecord({ name: freshName() });
		await record.read('app');
		await record.fold('app', () => bytes(9));
		await record.fold('app', () => bytes(9));
		expect(await record.read('app')).toEqual([bytes(9)]);
		record.close();
	});
});

describe('the seeded rule, which is the one that loses data quietly', () => {
	test('a fold before a read is refused, not merely wasteful', async () => {
		const name = freshName();
		const first = await openDurableRecord({ name });
		await first.read('app');
		await first.append('app', bytes(1));
		await first.append('app', bytes(2));
		first.close();

		// Unseeded, this fold would start from sequence zero: it would write its
		// state over the first record of a chain it never read, and sweep
		// nothing. The chain came back as [9, 2] before the guard existed.
		const second = await openDurableRecord({ name });
		await expect(second.fold('app', () => bytes(9))).rejects.toBeDefined();
		await second.read('app');
		expect(await second.read('app')).toEqual([bytes(1), bytes(2)]);
		second.close();
	});

	test('a second read does not roll the sequence back', async () => {
		const record = await openDurableRecord({ name: freshName() });
		await record.read('app');
		await record.append('app', bytes(1));
		// A read started here sees only [1], and reseeding from it would set the
		// sequence back below the append that lands next; the append after that
		// would then overwrite it. The chain came back as [1, 3] before.
		const reading = record.read('app');
		await record.append('app', bytes(2));
		await reading;
		await record.append('app', bytes(3));
		expect(await record.read('app')).toEqual([bytes(1), bytes(2), bytes(3)]);
		record.close();
	});

	test('a retired document can be written again without rehydrating', async () => {
		const record = await openDurableRecord({ name: freshName() });
		await record.read('notes/abc');
		await record.append('notes/abc', bytes(1));
		await record.retire('notes/abc');
		// Reachable through ADR-0279's copy verb: a row deleted here and copied
		// back arrives at the same address. This process emptied the chain, so
		// it knows what is there and does not have to be told again.
		await record.append('notes/abc', bytes(2));
		expect(await record.read('notes/abc')).toEqual([bytes(2)]);
		record.close();
	});
});

describe('shouldFold', () => {
	test('says no under the floor and yes once the tail outgrows the state', async () => {
		const record = await openDurableRecord({
			name: freshName(),
			floorBytes: 64,
		});
		await record.read('app');
		expect(record.shouldFold('app')).toBe(false);

		// The first record of a chain is its state, so one append is never a
		// tail worth collapsing however large it is.
		await record.append('app', sizedBytes(100));
		expect(record.shouldFold('app')).toBe(false);

		await record.append('app', sizedBytes(200));
		expect(record.shouldFold('app')).toBe(true);

		await record.fold('app', () => sizedBytes(300));
		expect(record.shouldFold('app')).toBe(false);
		record.close();
	});

	test('gives the same answer before and after a reopen', async () => {
		const name = freshName();
		const first = await openDurableRecord({ name, floorBytes: 64 });
		await first.read('app');
		await first.append('app', sizedBytes(100));
		await first.append('app', sizedBytes(200));
		expect(first.shouldFold('app')).toBe(true);
		first.close();

		const second = await openDurableRecord({ name, floorBytes: 64 });
		// Nothing is known before the read, and a fresh process must not guess
		// at a chain it has never seen.
		expect(second.shouldFold('app')).toBe(false);
		await second.read('app');
		// The same chain, so the same answer. `read` cannot tell a fold from an
		// update by looking, and neither can `append`; they agree because both
		// call the first record the state.
		expect(second.shouldFold('app')).toBe(true);
		second.close();
	});
});

describe('durability', () => {
	test('starts healthy and says so when a write stops landing', async () => {
		const record = await openDurableRecord({ name: freshName() });
		await record.read('app');
		const seen: boolean[] = [];
		record.durability.subscribe((healthy) => seen.push(healthy));
		expect(record.durability.healthy).toBe(true);

		// A value IndexedDB cannot structured-clone, which is the cheapest
		// deterministic stand-in for the real causes: quota, eviction, and a
		// store the browser has taken away.
		const unstorable = (() => undefined) as unknown as Uint8Array;
		await expect(record.append('app', unstorable)).rejects.toBeDefined();

		expect(record.durability.healthy).toBe(false);
		expect(seen).toEqual([false]);

		await record.append('app', bytes(1));
		expect(record.durability.healthy).toBe(true);
		expect(seen).toEqual([false, true]);
		record.close();
	});
});
