/**
 * The driver, over the same hub and authority that get deployed.
 *
 * Only the socket and the clock are stand-ins. The socket is a queue that
 * delivers in order exactly like a real one, and the clock is a list of due
 * tasks, so a test can hold messages in the wire and step time forward without
 * waiting for any of it.
 *
 * Every test that claims something arrived asserts on the RECEIVING replica's
 * own rows, never on a counter this file keeps, and every claim that a repair
 * happened is paired with a control showing the same schedule without the
 * repair does NOT converge. A rule on this branch once "worked" in a simulation
 * where nothing was ever delivered.
 */
import { defineLens } from '@epicenter/lens/lens';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { Result } from 'wellcrafted/result';

import { type BoundOf, createStore } from '../store/store.js';
import { openSyncAuthority } from './authority.js';
import { createSyncHub, type HubConnection } from './hub.js';
import { createSyncConnection, type SyncDial } from './connection.js';

const lens = defineLens({
	namespace: 'so.epicenter.honeycrisp',
	tables: { notes: { title: 'string' } },
});

function expectOk<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (result.error !== null) throw result.error;
	return result.data as TValue;
}

/** A network that delivers in order, and only when told to. */
function createWire() {
	const queue: (() => void)[] = [];
	return {
		defer(task: () => void) {
			queue.push(task);
		},
		settle() {
			let guard = 0;
			while (queue.length > 0) {
				if ((guard += 1) > 10_000) throw new Error('the wire never settled');
				(queue.shift() as () => void)();
			}
		},
		inFlight: () => queue.length,
	};
}
type Wire = ReturnType<typeof createWire>;

/**
 * A clock made of due tasks, satisfying the same `Schedule` the driver injects.
 *
 * The driver's backoff, its healthy window and its watchdog are all delays, and
 * so is the client's idle timer underneath it, so all four run on this one
 * clock and a test says how much time passed rather than waiting for it.
 */
function createClock() {
	let now = 0;
	let nextId = 0;
	const timers = new Map<number, { at: number; task: () => void }>();
	return {
		schedule(task: () => void, delayMs: number) {
			const id = (nextId += 1);
			timers.set(id, { at: now + delayMs, task });
			return () => timers.delete(id);
		},
		/** Run everything due within `ms`, in time order, including what it schedules. */
		advance(ms: number) {
			const target = now + ms;
			for (let guard = 0; ; guard += 1) {
				if (guard > 10_000) throw new Error('the clock never settled');
				let dueId: number | undefined;
				let dueAt = Number.POSITIVE_INFINITY;
				for (const [id, timer] of timers) {
					if (timer.at <= target && timer.at < dueAt) {
						dueAt = timer.at;
						dueId = id;
					}
				}
				if (dueId === undefined) break;
				const timer = timers.get(dueId) as { at: number; task: () => void };
				timers.delete(dueId);
				now = timer.at;
				timer.task();
			}
			now = target;
		},
		pending: () => timers.size,
	};
}
type Clock = ReturnType<typeof createClock>;

function openAuthority() {
	const database = createBunSqliteAdapter(new Database(':memory:'));
	const authority = openSyncAuthority({ database });
	return { authority, hub: createSyncHub({ authority, batch: 8 }) };
}

/**
 * One replica whose connection is driven entirely by `createSyncConnection`.
 *
 * Nothing here calls `nudge`, `attach`, `detach` or `receive`. That is the
 * point: everything a host used to write by hand is now the driver's, and the
 * host writes only `dial`.
 */
function openDriven({
	hub,
	wire,
	clock,
	...options
}: {
	hub: ReturnType<typeof createSyncHub>;
	wire: Wire;
	clock: Clock;
	healthyMs?: number;
	unacknowledgedMs?: number;
	backoff?: (attempts: number) => number;
}) {
	const store = createStore({
		database: createBunSqliteAdapter(new Database(':memory:')),
	});
	const db = expectOk(store.bind(lens)) as BoundOf<typeof lens>;

	/** Cursor each dial asked the authority to start after, oldest first. */
	const dialledFrom: number[] = [];
	/** How many frames the next socket swallows before delivering any. */
	let swallow = 0;
	let generation = 0;
	let breakSocket: (() => void) | undefined;

	const dial: SyncDial = ({ cursor, opened, received, closed }) => {
		dialledFrom.push(cursor);
		const mine = (generation += 1);
		const connection: HubConnection = {
			cursor,
			send: (bytes) =>
				wire.defer(() => {
					if (mine !== generation) return;
					if (swallow > 0) {
						swallow -= 1;
						return;
					}
					received(bytes);
				}),
		};
		opened({
			send: (bytes) =>
				wire.defer(() => {
					if (mine === generation) hub.receive(connection, bytes);
				}),
		});
		hub.join(connection);
		// The server dropping the socket, which is what a hibernating Durable
		// Object, a lost network and a rejected credential all look like here.
		breakSocket = () => {
			if (mine !== generation) return;
			generation += 1;
			hub.leave(connection);
			closed();
		};
		return () => {
			if (mine !== generation) return;
			generation += 1;
			hub.leave(connection);
		};
	};

	const connection = createSyncConnection({ store, dial, schedule: clock.schedule, ...options });

	return {
		store,
		db,
		connection,
		dialledFrom,
		/** Make the next socket lose its first `count` frames from the authority. */
		loseNextFrames(count: number) {
			swallow = count;
		},
		breakSocket: () => breakSocket?.(),
		titles: () =>
			expectOk(db.notes.list())
				.rows.map((row) => row.title)
				.sort(),
	};
}

function setup(
	options: {
		healthyMs?: number;
		unacknowledgedMs?: number;
		backoff?: (attempts: number) => number;
	} = {},
) {
	const wire = createWire();
	const clock = createClock();
	const { authority, hub } = openAuthority();
	const phone = openDriven({ hub, wire, clock, ...options });
	const laptop = openDriven({ hub, wire, clock, ...options });
	return { wire, clock, authority, hub, phone, laptop };
}

/**
 * Let time and delivery interleave, the way they do on a real device.
 *
 * In slices rather than one jump, and this is not a detail. Advancing the whole
 * interval before letting the wire deliver anything means a submission sent at
 * one timer cannot be acknowledged before the next fires, which manufactures a
 * stall the watchdog then correctly reports: the first version of this helper
 * did exactly that and made a working driver look broken.
 */
function run(wire: Wire, clock: Clock, ms: number, sliceMs = 100) {
	let elapsed = 0;
	for (;;) {
		wire.settle();
		if (elapsed >= ms) return;
		const slice = Math.min(sliceMs, ms - elapsed);
		clock.advance(slice);
		elapsed += slice;
	}
}

describe('a write syncs without anyone remembering to say so', () => {
	test('a row created on one device arrives on the other', () => {
		// Nothing in this test nudges or flushes. The store announces its own
		// local work and the driver starts the idle timer, which is the whole
		// point: a caller that forgets used to leave the write sitting in the
		// outbox until some unrelated write happened to start the timer.
		const { wire, clock, phone, laptop } = setup();
		phone.connection.start();
		laptop.connection.start();
		run(wire, clock, 0);

		expectOk(phone.db.notes.create({ title: 'Groceries' }));
		run(wire, clock, 1_000);

		expect(laptop.titles()).toEqual(['Groceries']);
	});

	test('CONTROL: it does NOT arrive before the idle timer fires', () => {
		// The isolation. If this ever fails, the test above is measuring the
		// harness delivering eagerly rather than the store's announcement.
		const { wire, clock, phone, laptop } = setup();
		phone.connection.start();
		laptop.connection.start();
		run(wire, clock, 0);

		expectOk(phone.db.notes.create({ title: 'Groceries' }));
		run(wire, clock, 0);

		expect(laptop.titles()).toEqual([]);
	});

	test('prose written into a row document syncs on the same timer', () => {
		const { wire, clock, phone, laptop } = setup();
		phone.connection.start();
		laptop.connection.start();
		run(wire, clock, 0);

		const note = expectOk(
			phone.db.notes.create({ title: 'Groceries' }, { document: ['body'] }),
		);
		const body = phone.db.notes.document(note.id)?.get('body', 'text');
		if (body === undefined) throw new Error('the row has no document');
		body.applyDelta(body.change.insert('milk and eggs') as never);
		run(wire, clock, 1_000);

		const arrived = laptop.db.notes.document(note.id)?.get('body', 'text');
		expect(JSON.stringify(arrived?.toJSON())).toContain('milk and eggs');
	});
});

describe('a gap is repaired without anybody noticing it', () => {
	test('a lost entry wedges the replica, and the driver reconnects it', () => {
		// The failure a randomised schedule found: a device wedged at 108 kept
		// receiving 118, 119 and 121 and rejecting all of them, with no error
		// surfaced and the socket perfectly healthy. The client sets
		// `needsResync` and waits for someone to notice; this is that someone.
		const { wire, clock, phone, laptop } = setup();
		phone.connection.start();
		laptop.connection.start();
		run(wire, clock, 0);

		// The laptop loses the frame carrying the first entry, so the second is
		// a gap and every later one is too.
		laptop.loseNextFrames(1);
		expectOk(phone.db.notes.create({ title: 'first' }));
		run(wire, clock, 1_000);
		expectOk(phone.db.notes.create({ title: 'second' }));
		run(wire, clock, 1_000);
		expect(laptop.connection.status().needsResync).toBe(true);

		// The backoff, and then the catch-up from the laptop's own cursor.
		run(wire, clock, 5_000);

		expect(laptop.titles()).toEqual(['first', 'second']);
		expect(laptop.connection.status().needsResync).toBe(false);
		expect(laptop.connection.status().lastReconnect).toBe('resync');
	});

	test('CONTROL: without the reconnect the same schedule stays wedged forever', () => {
		// The same lost frame, driven by hand the way every host used to drive
		// it, with the one rule that used to be optional left out. It never
		// recovers however long it is left alone.
		const wire = createWire();
		const clock = createClock();
		const { hub } = openAuthority();
		const phone = openDriven({ hub, wire, clock });
		const laptop = openDriven({
			hub,
			wire,
			clock,
			// A backoff so long it never elapses inside this test, which is what
			// "the caller never reconnects" looks like on this clock.
			backoff: () => 1_000_000,
		});
		phone.connection.start();
		laptop.connection.start();
		run(wire, clock, 0);

		laptop.loseNextFrames(1);
		expectOk(phone.db.notes.create({ title: 'first' }));
		run(wire, clock, 1_000);
		expectOk(phone.db.notes.create({ title: 'second' }));
		run(wire, clock, 60_000);

		expect(laptop.titles()).toEqual([]);
		expect(laptop.connection.status().needsResync).toBe(true);
	});
});

describe('a socket that dies is dialled again from the replica own cursor', () => {
	test('work written while disconnected goes out on reconnect', () => {
		const { wire, clock, phone, laptop } = setup();
		phone.connection.start();
		laptop.connection.start();
		run(wire, clock, 0);
		expectOk(phone.db.notes.create({ title: 'before' }));
		run(wire, clock, 1_000);
		expect(laptop.titles()).toEqual(['before']);

		phone.breakSocket();
		expectOk(phone.db.notes.create({ title: 'while offline' }));
		run(wire, clock, 5_000);

		expect(laptop.titles()).toEqual(['before', 'while offline']);
		expect(phone.connection.status().lastReconnect).toBe('closed');
	});

	test('every dial asks from what this replica has durably applied', () => {
		const { wire, clock, phone, laptop } = setup();
		phone.connection.start();
		laptop.connection.start();
		run(wire, clock, 0);
		expectOk(phone.db.notes.create({ title: 'first' }));
		run(wire, clock, 1_000);

		laptop.breakSocket();
		run(wire, clock, 5_000);

		// Not zero on the second dial. A reconnect that asked from the start
		// would work, and would re-download everything on every wobble.
		expect(laptop.dialledFrom).toEqual([0, 1]);
	});

	test('a socket that never stays up backs off, and a working one resets it', () => {
		const { wire, clock, phone } = setup({ healthyMs: 5_000 });
		phone.connection.start();
		run(wire, clock, 0);

		for (let attempt = 0; attempt < 3; attempt += 1) {
			phone.breakSocket();
			// Just past this attempt's backoff, and well short of the healthy
			// window, so the redial happens and never counts as a good connection.
			run(wire, clock, 1_000 * 2 ** attempt + 1);
		}
		expect(phone.connection.status().attempts).toBe(3);

		// One socket that lasts, and the count goes back to nothing.
		run(wire, clock, 5_000);

		expect(phone.connection.status().attempts).toBe(0);
	});
});

describe('a submission nobody answers is not waited on forever', () => {
	test('the watchdog reconnects, and the work is delivered afterwards', () => {
		// The production stall in `evidence/workerd/results.md`, made
		// self-healing without knowing what causes it: a sustained run against
		// Cloudflare stopped waiting for an acknowledgement, four hypotheses
		// were tested and none of them was it.
		const { wire, clock, phone, laptop } = setup({ unacknowledgedMs: 10_000 });
		phone.connection.start();
		laptop.connection.start();
		run(wire, clock, 0);

		// The push leaves and its acknowledgement never comes back.
		phone.loseNextFrames(1);
		expectOk(phone.db.notes.create({ title: 'first' }));
		run(wire, clock, 1_000);
		expect(phone.connection.status().inFlight).toBe(true);

		// The damage. One submission is out at a time, so nothing this device
		// writes from here on can leave, and every layer still reports success.
		expectOk(phone.db.notes.create({ title: 'second' }));
		run(wire, clock, 5_000);
		expect(laptop.titles()).toEqual(['first']);

		// Two ticks: the first records the submission, the second finds the same
		// one still out. One tick would reconnect a busy client on every pass.
		run(wire, clock, 25_000);

		expect(phone.connection.status().lastReconnect).toBe('stalled');
		expect(laptop.titles()).toEqual(['first', 'second']);
	});

	test('CONTROL: a client that keeps getting acknowledged is never reconnected', () => {
		// The false positive the submission NUMBER exists to avoid. Only one
		// submission is ever out and the next starts the moment the previous is
		// acknowledged, so under sustained work `inFlight` is continuously true
		// on a completely healthy client.
		const { wire, clock, phone, laptop } = setup({ unacknowledgedMs: 1_000 });
		phone.connection.start();
		laptop.connection.start();
		run(wire, clock, 0);

		for (let index = 0; index < 20; index += 1) {
			expectOk(phone.db.notes.create({ title: `note ${index}` }));
			run(wire, clock, 1_100);
		}

		expect(phone.connection.status().lastReconnect).toBeUndefined();
		expect(laptop.titles()).toHaveLength(20);
	});
});

describe('the driver lets go of what it has abandoned', () => {
	test('a dead socket cannot detach the one that replaced it', () => {
		const { wire, clock, phone, laptop } = setup();
		phone.connection.start();
		laptop.connection.start();
		run(wire, clock, 0);
		const stale = phone.breakSocket;
		run(wire, clock, 5_000);

		// The socket that died two connections ago, reporting its close late.
		stale();
		expectOk(phone.db.notes.create({ title: 'still connected' }));
		run(wire, clock, 1_000);

		expect(laptop.titles()).toEqual(['still connected']);
	});

	test('disposing stops dialling and stops listening to the store', () => {
		const { wire, clock, phone } = setup();
		phone.connection.start();
		run(wire, clock, 0);
		const dials = phone.dialledFrom.length;

		phone.connection[Symbol.dispose]();
		phone.breakSocket();
		expectOk(phone.db.notes.create({ title: 'after disposal' }));
		run(wire, clock, 60_000);

		expect(phone.dialledFrom).toHaveLength(dials);
		expect(phone.connection.status().connected).toBe(false);
	});
});
