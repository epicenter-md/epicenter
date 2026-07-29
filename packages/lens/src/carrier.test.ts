/**
 * Observation Carrier Loop Tests
 *
 * Verifies the loop itself rather than the outcomes two downstream clients
 * observe through it. `@epicenter/data` and `@epicenter/app` both prove that a
 * failed open releases the host surface it had already registered; neither can
 * reach the invariants that decide whether the loop is still correct on the
 * hundredth reconnect.
 *
 * Everything here is driven through a fake socket, because the four conditions
 * that matter are exactly the ones a healthy host never produces on request: a
 * dial that throws, a socket that dies before it opens, a socket that reports
 * its death twice, and a host that sends a frame this client cannot read.
 *
 * Key behaviors:
 * - A failed open rejects with its cause and leaves no redial running
 * - A duplicated death produces exactly one redial
 * - Consecutive-failure counting resets on every successful open
 * - A reopen heals every subscribed handle once, and the first open heals none
 * - Closing during a pending redial stops the loop
 * - An unreadable frame is dropped and reported, never thrown at the socket
 */

import { expect, test } from 'bun:test';

import { type ObservationSocket, openObservationCarrier } from './carrier.js';
import {
	createInvalidationDispatcher,
	type TableInvalidation,
} from './observation.js';

/** Long enough for a zero-delay redial timer to have fired if one was armed. */
const afterPendingTimers = () =>
	new Promise((resolve) => setTimeout(resolve, 10));

/** The failure an opener rejected with, asserted to be a rejection at all. */
async function rejectionOf(opening: Promise<unknown>): Promise<Error> {
	try {
		await opening;
	} catch (failure) {
		return failure as Error;
	}
	throw new Error('The opener resolved where it was expected to reject');
}

class FakeSocket implements ObservationSocket {
	readonly listeners = new Map<
		string,
		((event: { data: unknown }) => void)[]
	>();
	isClosedByCarrier = false;

	addEventListener(type: 'open', listener: () => void): void;
	addEventListener(type: 'close', listener: () => void): void;
	addEventListener(type: 'error', listener: () => void): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: unknown }) => void,
	): void;
	addEventListener(
		type: string,
		listener: (event: { data: unknown }) => void,
	): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	close(): void {
		this.isClosedByCarrier = true;
	}

	/** Fire one lifecycle event the way a real socket would. */
	emit(type: 'open' | 'close' | 'error'): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener({ data: undefined });
		}
	}

	/** Deliver one `message` payload exactly as the socket received it. */
	send(data: unknown): void {
		for (const listener of this.listeners.get('message') ?? []) {
			listener({ data });
		}
	}
}

/**
 * One recorded dial script.
 *
 * `attempts` is what the loop believes about consecutive failures: the carrier
 * only ever tells the outside world that number by asking for a delay, so
 * asking for the delay is the only honest way to observe the reset.
 */
function trackDials({ delayMs = 0 }: { delayMs?: number } = {}) {
	const sockets: FakeSocket[] = [];
	const attempts: number[] = [];
	const reported: unknown[] = [];
	return {
		sockets,
		attempts,
		reported,
		dial: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		redialDelayMs: (attempt: number) => {
			attempts.push(attempt);
			return delayMs;
		},
		log: {
			error: (error: unknown) => {
				reported.push(error);
			},
		},
		/** The socket of one dial, asserted to exist so no test reads `undefined`. */
		socketAt(index: number): FakeSocket {
			const socket = sockets[index];
			if (socket === undefined) throw new Error(`No socket for dial ${index}`);
			return socket;
		},
	};
}

test('an opener whose first dial throws rejects with the dial failure as its cause', async () => {
	const cause = new Error('this environment has no WebSocket');
	let dials = 0;
	const opening = openObservationCarrier({
		observation: createInvalidationDispatcher(),
		redialDelayMs: () => 0,
		dial: () => {
			dials += 1;
			throw cause;
		},
	});

	const failure = await rejectionOf(opening);
	// The reason is readable from the message alone, because every caller wraps
	// this and reports the wrapper's message rather than walking `cause`.
	expect(failure.message).toBe(
		'Observation carrier could not dial: this environment has no WebSocket',
	);
	expect(failure.cause).toBe(cause);

	// A carrier nobody holds has nothing to heal, so the loop must not have
	// armed a redial the rejection would then have to unwind.
	await afterPendingTimers();
	expect(dials).toBe(1);
});

test('an opener whose first socket closes before opening rejects and stops', async () => {
	const script = trackDials();
	const opening = openObservationCarrier({
		observation: createInvalidationDispatcher(),
		dial: script.dial,
		redialDelayMs: script.redialDelayMs,
	});
	script.socketAt(0).emit('close');

	const failure = await rejectionOf(opening);
	expect(failure.message).toBe('Observation carrier closed before it opened');
	await afterPendingTimers();
	expect(script.sockets.length).toBe(1);
	expect(script.attempts).toEqual([]);
});

test('a socket that reports its death twice produces exactly one redial', async () => {
	const script = trackDials();
	const opening = openObservationCarrier({
		observation: createInvalidationDispatcher(),
		dial: script.dial,
		redialDelayMs: script.redialDelayMs,
	});
	script.socketAt(0).emit('open');
	const carrier = await opening;

	// A browser fires `error` before `close` on a carrier that drops, and a
	// pathological one may repeat either. All of it is one death.
	script.socketAt(0).emit('error');
	script.socketAt(0).emit('close');
	script.socketAt(0).emit('close');
	script.socketAt(0).emit('error');

	await afterPendingTimers();
	expect(script.sockets.length).toBe(2);
	expect(script.attempts).toEqual([1]);
	carrier.close();
});

test('consecutive-failure counting resets on every successful open', async () => {
	const script = trackDials();
	const opening = openObservationCarrier({
		observation: createInvalidationDispatcher(),
		dial: script.dial,
		redialDelayMs: script.redialDelayMs,
	});
	script.socketAt(0).emit('open');
	const carrier = await opening;

	script.socketAt(0).emit('close');
	await afterPendingTimers();
	// The redial never opens, so this failure is the second in a row.
	script.socketAt(1).emit('close');
	await afterPendingTimers();
	// This one does, which puts the loop back at the start of its backoff.
	script.socketAt(2).emit('open');
	script.socketAt(2).emit('close');
	await afterPendingTimers();

	expect(script.attempts).toEqual([1, 2, 1]);
	carrier.close();
});

test('a reopen heals every subscribed handle once, and the first open heals none', async () => {
	const observation = createInvalidationDispatcher();
	const script = trackDials();
	const opening = openObservationCarrier({
		observation,
		dial: script.dial,
		redialDelayMs: script.redialDelayMs,
	});
	script.socketAt(0).emit('open');
	const carrier = await opening;

	const table: TableInvalidation[] = [];
	let values = 0;
	observation.subscribeTable(
		'so.epicenter.carrier.tests',
		'notes',
		(invalidation) => {
			table.push(invalidation);
		},
	);
	observation.subscribeValue(
		{
			kind: 'value',
			namespace: 'so.epicenter.carrier.tests',
			valueName: 'theme',
		},
		() => {
			values += 1;
		},
	);

	// Law 7: the opener resolved after the first open, so nothing could have
	// subscribed across it and nothing is owed a gap.
	expect(table).toEqual([]);
	expect(values).toBe(0);

	script.socketAt(0).emit('close');
	await afterPendingTimers();
	script.socketAt(1).emit('open');

	// Law 6: the reopen is the whole signal, and the client turns it into the
	// strongest honest statement it can make about each handle it holds.
	expect(table).toEqual([{ scope: 'table' }]);
	expect(values).toBe(1);
	carrier.close();
});

test('closing during a pending redial stops the loop', async () => {
	const script = trackDials({ delayMs: 20 });
	const opening = openObservationCarrier({
		observation: createInvalidationDispatcher(),
		dial: script.dial,
		redialDelayMs: script.redialDelayMs,
	});
	script.socketAt(0).emit('open');
	const carrier = await opening;

	script.socketAt(0).emit('close');
	expect(script.attempts).toEqual([1]);
	carrier.close();

	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(script.sockets.length).toBe(1);
});

test('closing twice is a no-op and closes the live socket once', async () => {
	const script = trackDials();
	const opening = openObservationCarrier({
		observation: createInvalidationDispatcher(),
		dial: script.dial,
		redialDelayMs: script.redialDelayMs,
	});
	script.socketAt(0).emit('open');
	const carrier = await opening;

	carrier.close();
	carrier.close();
	expect(script.socketAt(0).isClosedByCarrier).toBeTrue();
	await afterPendingTimers();
	expect(script.sockets.length).toBe(1);
});

test.each([
	['a payload that is not a string', { changes: [] }],
	['a payload that is not JSON', 'not json at all'],
	['an envelope of another type', JSON.stringify({ type: 'hello' })],
	[
		'changes that are not an array',
		JSON.stringify({ type: 'invalidation', changes: 'everything' }),
	],
	[
		'an address that is not an object',
		JSON.stringify({ type: 'invalidation', changes: ['notes'] }),
	],
	[
		'an address of an unknown kind',
		JSON.stringify({
			type: 'invalidation',
			changes: [{ kind: 'blob', namespace: 'so.epicenter.carrier.tests' }],
		}),
	],
	[
		'a row address with no rowId',
		JSON.stringify({
			type: 'invalidation',
			changes: [
				{
					kind: 'row',
					namespace: 'so.epicenter.carrier.tests',
					tableName: 'notes',
				},
			],
		}),
	],
	[
		'a value address whose valueName is not a string',
		JSON.stringify({
			type: 'invalidation',
			changes: [
				{
					kind: 'value',
					namespace: 'so.epicenter.carrier.tests',
					valueName: 7,
				},
			],
		}),
	],
	[
		'one unreadable address beside readable ones',
		JSON.stringify({
			type: 'invalidation',
			changes: [
				{
					kind: 'row',
					namespace: 'so.epicenter.carrier.tests',
					tableName: 'notes',
					rowId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
				},
				null,
			],
		}),
	],
] as const)('%s is dropped rather than thrown at the socket', async (_case, payload) => {
	const observation = createInvalidationDispatcher();
	const script = trackDials();
	const opening = openObservationCarrier({
		observation,
		dial: script.dial,
		redialDelayMs: script.redialDelayMs,
		log: script.log,
	});
	script.socketAt(0).emit('open');
	const carrier = await opening;

	const seen: TableInvalidation[] = [];
	observation.subscribeTable(
		'so.epicenter.carrier.tests',
		'notes',
		(invalidation) => {
			seen.push(invalidation);
		},
	);

	// A throw here would escape the socket's `message` listener, where nothing
	// is left to catch it.
	expect(() => script.socketAt(0).send(payload)).not.toThrow();
	// A frame that names one unreadable address is dropped whole: a partial
	// batch would be an under-report, which law 1 forbids.
	expect(seen).toEqual([]);

	// The socket survives it, so a cosmetic mismatch never becomes a surface
	// that stops updating.
	script.socketAt(0).send(
		JSON.stringify({
			type: 'invalidation',
			changes: [
				{
					kind: 'row',
					namespace: 'so.epicenter.carrier.tests',
					tableName: 'notes',
					rowId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
				},
			],
		}),
	);
	expect(seen).toEqual([
		{ scope: 'rows', rowIds: ['bbbbbbbbbbbbbbbbbbbbbbbb'] },
	]);
	expect(script.sockets.length).toBe(1);
	carrier.close();
});

test('an unreadable frame is reported rather than silently discarded', async () => {
	const script = trackDials();
	const opening = openObservationCarrier({
		observation: createInvalidationDispatcher(),
		dial: script.dial,
		redialDelayMs: script.redialDelayMs,
		log: script.log,
	});
	script.socketAt(0).emit('open');
	const carrier = await opening;

	// Every way a frame can be unreadable says so. A silent drop is the one
	// outcome that leaves a surface quietly out of date with nothing to read.
	script.socketAt(0).send(new Uint8Array([1, 2, 3]));
	script.socketAt(0).send('{');
	script.socketAt(0).send(JSON.stringify({ type: 'hello' }));
	script
		.socketAt(0)
		.send(JSON.stringify({ type: 'invalidation', changes: [1] }));

	expect(script.reported.map((error) => (error as Error).message)).toEqual([
		'Observation frame was not text',
		'Observation frame was not JSON',
		'Observation frame was not an invalidation',
		'Observation frame named an unreadable address',
	]);
	carrier.close();
});

test('a redial that cannot dial is reported, because only the loop can see it', async () => {
	const script = trackDials();
	let shouldThrow = false;
	const opening = openObservationCarrier({
		observation: createInvalidationDispatcher(),
		// Only the first redial is allowed to fire inside this test, so what it
		// does next is observed rather than raced against.
		redialDelayMs: (attempt) => {
			script.attempts.push(attempt);
			return attempt === 1 ? 0 : 60_000;
		},
		log: script.log,
		dial: () => {
			if (shouldThrow) throw new Error('WebSocket vanished');
			return script.dial();
		},
	});
	script.socketAt(0).emit('open');
	const carrier = await opening;

	shouldThrow = true;
	script.socketAt(0).emit('close');
	await afterPendingTimers();

	const reported = script.reported[0] as Error;
	expect(reported.message).toBe('Observation carrier could not redial');
	expect((reported.cause as Error).message).toBe('WebSocket vanished');
	// It keeps trying: a throw is a failed attempt like any other.
	expect(script.attempts).toEqual([1, 2]);
	carrier.close();
});
