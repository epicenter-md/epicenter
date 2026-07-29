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
 *   ObservationCarrier.open} settles once, on the first dial, and answers
 *   whether a carrier exists. That is what buys law 2: a caller that holds a
 *   handle can subscribe and then read with nothing able to land in between, so
 *   no initial fire is needed to cover a window that does not exist.
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
	changes: Address[];
};

export type ObservationCarrier = {
	/**
	 * Dial, and resolve once the first attempt has settled.
	 *
	 * `true` means a carrier is established and every later drop will be redialed
	 * behind the caller's back. `false` means the first dial failed and the
	 * carrier has already closed itself, so a caller that is declining has
	 * nothing left to tear down but its own host-side registration.
	 */
	open(): Promise<boolean>;
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

export function createObservationCarrier({
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
	 * Where a dial that threw is reported. A socket that merely closed is
	 * ordinary and stays silent; a dial that could not even produce one says
	 * something about the environment, and the redial loop would otherwise hide
	 * it forever.
	 */
	log?: InvalidationErrorReporter;
}): ObservationCarrier {
	let socket: ObservationSocket | undefined;
	let redialTimer: unknown;
	let failedAttempts = 0;
	let isClosed = false;

	function connect({ isInitial }: { isInitial: boolean }): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			if (isClosed) return resolve(false);
			let settled = false;
			const settle = (established: boolean) => {
				if (settled) return;
				settled = true;
				resolve(established);
			};

			let next: ObservationSocket;
			try {
				next = dial();
			} catch (cause) {
				// A dial that threw never produced a socket, so no `close` event is
				// coming to drive the redial from.
				log.error(new Error('Observation carrier could not dial', { cause }));
				failedAttempts += 1;
				scheduleRedial();
				return settle(false);
			}
			socket = next;

			next.addEventListener('open', () => {
				failedAttempts = 0;
				settle(true);
				// Only a reopen has handles to heal. The first carrier precedes every
				// subscription a caller can have installed, so there is nothing to
				// tell (law 7 is what makes that true).
				if (!isInitial) observation.invalidateAll();
			});
			next.addEventListener('message', (event) => {
				const changes = readObservationFrame(event.data);
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
				if (isClosed) return;
				failedAttempts += 1;
				settle(false);
				scheduleRedial();
			});
		});
	}

	function scheduleRedial(): void {
		if (isClosed || redialTimer !== undefined) return;
		redialTimer = setTimeout(
			() => {
				redialTimer = undefined;
				if (!isClosed) void connect({ isInitial: false });
			},
			redialDelayMs(Math.max(failedAttempts, 1)),
		);
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

	return {
		async open(): Promise<boolean> {
			const established = await connect({ isInitial: true });
			// A carrier that never opened has no handles to heal and no caller
			// holding it. Stopping here is what keeps a declined open from leaving a
			// redial loop running behind it.
			if (!established) close();
			return established;
		},
		close,
	};
}

/**
 * Read one carrier frame, or nothing when the host said something this client
 * does not recognize.
 *
 * An unreadable frame is dropped rather than thrown: the carrier's job is
 * liveness, and killing the socket over one bad message would turn a cosmetic
 * mismatch into a surface that stops updating.
 */
function readObservationFrame(data: unknown): readonly Address[] | undefined {
	if (typeof data !== 'string') return undefined;
	try {
		const parsed: unknown = JSON.parse(data);
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			!('type' in parsed) ||
			parsed.type !== 'invalidation' ||
			!('changes' in parsed) ||
			!Array.isArray(parsed.changes)
		) {
			return undefined;
		}
		return (parsed as ObservationFrame).changes;
	} catch {
		return undefined;
	}
}
