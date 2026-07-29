import { expect, test } from 'bun:test';
import { createFollowGate } from './follow-gate';

test('a run owns the gate until something takes it away', () => {
	const gate = createFollowGate();

	const isCurrent = gate.begin();

	expect(isCurrent()).toBe(true);
});

test('a newer run supersedes the one in flight', () => {
	// Following a second post must stop the first loop rather than run both.
	const gate = createFollowGate();
	const first = gate.begin();

	const second = gate.begin();

	expect(first()).toBe(false);
	expect(second()).toBe(true);
});

test('closing the gate revokes a run that is mid-await', () => {
	const gate = createFollowGate();
	const isCurrent = gate.begin();
	expect(isCurrent()).toBe(true);

	gate.close();

	expect(isCurrent()).toBe(false);
	expect(gate.isClosed).toBe(true);
});

test('a run begun AFTER close never owns the gate', async () => {
	// The actual bug: `refreshAttempts().then(() => follow(...))`. The component is
	// destroyed during the await, and the continuation then starts a ten-minute
	// poll owned by a surface that no longer exists. A plain "am I the newest run"
	// check would have said yes.
	const gate = createFollowGate();

	const pending = Promise.resolve().then(() => {
		const isCurrent = gate.begin();
		return isCurrent();
	});
	gate.close();

	expect(await pending).toBe(false);
});

test('closing is permanent, so no later run can reopen it', () => {
	const gate = createFollowGate();
	gate.close();

	expect(gate.begin()()).toBe(false);
	expect(gate.begin()()).toBe(false);
});

test('a real follow loop stops on the iteration after teardown', async () => {
	// End to end over the shape the composer actually uses: check the predicate
	// after every await, so at most one more read happens before it stops.
	const gate = createFollowGate();
	const reads: number[] = [];

	const loop = (async () => {
		const isCurrent = gate.begin();
		if (!isCurrent()) return;
		for (let round = 0; round < 100; round += 1) {
			await Promise.resolve();
			if (!isCurrent()) return;
			reads.push(round);
			if (reads.length === 3) gate.close();
		}
	})();

	await loop;

	// Stopped at the teardown rather than running to 100.
	expect(reads).toEqual([0, 1, 2]);
});
