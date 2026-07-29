/**
 * @fileoverview The socket loop that keeps an invalidation dispatcher fed.
 *
 * A dispatcher holds listeners and nothing else. Something has to dial a
 * host-owned socket, read the frames it sends, notice when it drops, redial it,
 * and tell every handle that a gap happened. That loop is the same wherever it
 * runs: the trusted desktop proxy in `@epicenter/data` and the installed-app
 * client in `@epicenter/app` had written it twice, and a leak fixed in one had
 * to be fixed again in the other.
 *
 * So it is written once here, and it is written without an environment. The
 * carrier never constructs a socket; it asks its caller to dial one. That is
 * what keeps this package free of `DOM` and `@types/node`, and it is also what
 * lets a test hand over a fake without a browser.
 *
 * Two laws of ADR-0187 live in this file:
 *
 * - **Law 6, a carrier gap heals locally.** Every reopen after the first tells
 *   the dispatcher to invalidate everything. The wire encodes no reconnection,
 *   reset, or scope; the client that noticed the gap is the one that knows which
 *   handles were listening across it, and a row deleted while the socket was
 *   down has left nothing behind to name.
 * - **Law 7, the carrier is established before the opener resolves.** {@link
 *   openObservationCarrier} answers only after the first dial settles, and it
 *   answers with a live carrier or not at all. That is what buys law 2: a caller
 *   that holds a handle can subscribe and then read with nothing able to land in
 *   between, so no initial fire is needed to cover a window that does not exist.
 */

import type { Address } from './addresses.js';
import type {
	InvalidationDispatcher,
	InvalidationErrorReporter,
} from './observation.js';

/**
 * The two timer functions this loop needs, named locally.
 *
 * This package compiles against `lib: ESNext` with no environment types,
 * because its declarations are published and then typechecked inside a
 * stranger's project against their `lib` and their dependency versions. Timers
 * are not in the ECMAScript library, and they are in every host that could
 * possibly run an observation carrier. Naming the two calls here keeps `DOM` and
 * `@types/node` out of the published surface without pretending the timer is
 * not there.
 */
declare const setTimeout: (handler: () => void, delayMs: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;

/**
 * A socket this carrier can drive.
 *
 * Narrower than `WebSocket` on purpose: the loop uses four events and one
 * method, and naming exactly those is what lets a caller pass a browser socket,
 * a Bun socket, or a test double through the same parameter.
 */
export type ObservationSocket = {
	addEventListener(type: 'open', listener: () => void): void;
	addEventListener(type: 'close', listener: () => void): void;
	addEventListener(type: 'error', listener: () => void): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: unknown }) => void,
	): void;
	close(): void;
};

/**
 * One committed batch of addresses, forwarded whole.
 *
 * The wire says which addresses moved and nothing else. It does not encode
 * reconnection, reset, table scope, operation kind, or a revision cursor: only
 * the client knows which handles it was holding across a gap, so synthesizing
 * the recovery is its job rather than the host's.
 */
export type ObservationFrame = {
	type: 'invalidation';
	/**
	 * Read-only, because every producer of one already holds a committed batch it
	 * must not mutate. A mutable array here would make each of them copy a
	 * `readonly Address[]` per socket per commit purely to satisfy this type.
	 */
	changes: readonly Address[];
};

export type ObservationCarrier = {
	/**
	 * Stop redialing, drop the socket, and release every listener.
	 *
	 * The dispatcher is cleared here because a dispatcher with no carrier can
	 * never fire again; leaving its listeners registered would only retain them.
	 * Calling this twice is a no-op.
	 */
	close(): void;
};

/**
 * Backoff for a loopback socket whose server is the same process tree.
 *
 * Short at the start because the common cause is a transient loopback carrier
 * gap; capped low because the cost of a redial here is a localhost connection,
 * and a surface that stays dark after sleep or wake is a far worse outcome than
 * a few extra attempts.
 */
function defaultObservationRedialDelayMs(attempt: number): number {
	return Math.min(250 * 2 ** (attempt - 1), 5_000);
}

export async function openObservationCarrier({
	dial,
	observation,
	redialDelayMs = defaultObservationRedialDelayMs,
	log = { error: () => undefined },
}: {
	/** Open one socket to the host. May throw; a throw is a failed dial. */
	dial: () => ObservationSocket;
	/** Where frames land and where a gap is announced. */
	observation: InvalidationDispatcher;
	/**
	 * How long to wait before redialing after the carrier drops. Called with the
	 * number of consecutive failures, starting at 1.
	 */
	redialDelayMs?: (attempt: number) => number;
	/**
	 * Where a failure the redial loop would otherwise hide is reported.
	 *
	 * A socket that merely closed is ordinary and stays silent, and a failed open
	 * is not reported here at all: it rejects with its cause attached, so the
	 * caller already holds it. What is left is what only the loop can see, and
	 * would otherwise see forever in silence: a redial that could not produce a
	 * socket, and a frame this client could not read.
	 */
	log?: InvalidationErrorReporter;
}): Promise<ObservationCarrier> {
	let socket: ObservationSocket | undefined;
	let redialTimer: unknown;
	let failedAttempts = 0;
	let isClosed = false;
	/**
	 * Whether the opener is still waiting to be told what happened.
	 *
	 * One flag decides both branches this loop has. While the opener waits, a
	 * failure is its answer: no carrier has been handed out, so there is no
	 * handle to heal and nothing to retry behind a caller who is about to be told
	 * the open failed. Once it has been answered, every failure belongs to the
	 * redial loop and every reopen heals (law 6).
	 */
	let isOpening = true;
	let openingFailure: Error | undefined;

	/** Dial once. The promise settles when that dial does, either way. */
	function connect(): Promise<void> {
		return new Promise<void>((settle) => {
			let next: ObservationSocket;
			try {
				next = dial();
			} catch (cause) {
				// A dial that threw never produced a socket, so no `close` event is
				// coming to drive the redial from.
				if (isOpening) {
					isOpening = false;
					openingFailure = new Error('Observation carrier could not dial', {
						cause,
					});
				} else {
					log.error(
						new Error('Observation carrier could not redial', { cause }),
					);
					redialAfterFailure();
				}
				return settle();
			}
			socket = next;

			next.addEventListener('open', () => {
				failedAttempts = 0;
				// The first open answers the opener; only a reopen has handles to
				// heal. The first carrier precedes every subscription a caller can
				// have installed, so there is nothing to tell (law 7 is what makes
				// that true).
				if (isOpening) isOpening = false;
				else observation.invalidateAll();
				settle();
			});
			next.addEventListener('message', (event) => {
				const changes = readObservationFrame(event.data, log);
				if (changes !== undefined) observation.deliver(changes);
			});
			// `error` and `close` are one outcome here: the socket is gone and the
			// only response is to redial. Browsers fire `error` before `close` on a
			// failed dial, so redialing from `close` alone misses nothing while
			// redialing from both would dial twice. This listener exists so a
			// browser does not report the error as unhandled.
			next.addEventListener('error', () => undefined);
			next.addEventListener('close', () => {
				if (socket !== next) return;
				socket = undefined;
				if (isClosed) return settle();
				if (isOpening) {
					isOpening = false;
					openingFailure = new Error(
						'Observation carrier closed before it opened',
					);
				} else {
					redialAfterFailure();
				}
				settle();
			});
		});
	}

	/**
	 * Count this failure and arrange another attempt.
	 *
	 * Reachable only once the opener has been answered. At most one dial is ever
	 * in flight, from two directions: a socket the loop has already replaced has
	 * its events dropped by identity above, and a timer already armed is never
	 * armed a second time.
	 */
	function redialAfterFailure(): void {
		failedAttempts += 1;
		if (isClosed || redialTimer !== undefined) return;
		redialTimer = setTimeout(() => {
			redialTimer = undefined;
			if (!isClosed) void connect();
		}, redialDelayMs(failedAttempts));
	}

	function close(): void {
		if (isClosed) return;
		isClosed = true;
		clearTimeout(redialTimer);
		redialTimer = undefined;
		socket?.close();
		socket = undefined;
		observation.clear();
	}

	await connect();
	if (openingFailure !== undefined) {
		// A carrier that never opened has no handles to heal and no caller holding
		// it, so it releases everything it touched and explains itself. Answering
		// with a sentinel instead would make every caller re-derive "no carrier"
		// from a value, and would lose the reason a person needs to fix it.
		close();
		throw openingFailure;
	}
	return { close };
}

/**
 * Read one carrier frame, or nothing when the host said something this client
 * does not recognize.
 *
 * An unreadable frame is dropped rather than thrown: the carrier's job is
 * liveness, and killing the socket over one bad message would turn a cosmetic
 * mismatch into a surface that stops updating.
 *
 * Keeping that promise means reading every address, not just the envelope
 * around them. The dispatcher dereferences `kind`, `namespace`, `tableName`,
 * `rowId`, and `valueName` off each element, so a well-formed envelope holding
 * one malformed element would throw a `TypeError` out of the socket's `message`
 * listener, where nothing is left to catch it.
 *
 * A frame with one bad address is dropped whole rather than filtered down to its
 * readable elements. Law 1 lets invalidation over-report and never under-report,
 * and a partial batch is exactly an under-report: it would tell a handle that
 * three rows moved while quietly withholding a fourth.
 */
function readObservationFrame(
	data: unknown,
	log: InvalidationErrorReporter,
): readonly Address[] | undefined {
	if (typeof data !== 'string') return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch (cause) {
		log.error(new Error('Observation frame was not JSON', { cause }));
		return undefined;
	}
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('type' in parsed) ||
		parsed.type !== 'invalidation' ||
		!('changes' in parsed) ||
		!Array.isArray(parsed.changes)
	) {
		log.error(new Error('Observation frame was not an invalidation'));
		return undefined;
	}
	const changes: unknown[] = parsed.changes;
	if (!changes.every(isReadableAddress)) {
		log.error(new Error('Observation frame named an unreadable address'));
		return undefined;
	}
	return changes;
}

/**
 * Whether one element of a frame can be read as an address.
 *
 * Structural rather than the durable address grammar, and deliberately so. What
 * this has to buy is a safe dereference. The owner that admitted the write
 * already checked the namespace shape, the SQL-safe table name, and the byte
 * ceilings, so re-running that grammar over every address of every commit would
 * charge the carrier's hot path for a second opinion about data this client
 * could not repair either way.
 */
function isReadableAddress(value: unknown): value is Address {
	if (typeof value !== 'object' || value === null) return false;
	if (!('namespace' in value) || typeof value.namespace !== 'string') {
		return false;
	}
	if (!('kind' in value)) return false;
	if (value.kind === 'row') {
		return (
			'tableName' in value &&
			typeof value.tableName === 'string' &&
			'rowId' in value &&
			typeof value.rowId === 'string'
		);
	}
	return (
		value.kind === 'value' &&
		'valueName' in value &&
		typeof value.valueName === 'string'
	);
}
