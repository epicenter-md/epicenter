/**
 * The half of a connection that is correctness, over the half that is a socket.
 *
 * `createSyncClient` deliberately owns no socket, and that is worth keeping:
 * every timing rule in it is testable without a network, which is not a
 * hypothetical benefit here, because a cursor rule on this branch once "worked"
 * in a simulation where nothing was ever delivered. Socket CONSTRUCTION also
 * genuinely differs per host: a browser origin builds a URL and carries a
 * cookie, a desktop window carries a bearer, a lab page carries neither.
 *
 * What was not legitimate is that the rules for DRIVING that socket lived in
 * each host's own copy of a connect loop. Reconnecting when the client reports
 * `needsResync` is one of them, and it is a correctness requirement rather than
 * a nicety: a randomised schedule wedged a device at position 108 while it kept
 * receiving 118, 119 and 121 and rejecting every one, with no error surfaced
 * anywhere and the socket perfectly healthy. A rule like that cannot be
 * something each application remembers.
 *
 * So the split is: the host says HOW to make a socket, and this file says what
 * to do with one. `createSyncClient` is unchanged underneath.
 *
 * ## What this owns
 *
 * - The cursor goes into every dial, read fresh, so a reconnect is always a
 *   catch-up from what this replica has applied.
 * - Attach on open, feed on message, detach on close.
 * - Reconnect when the socket closes, with backoff.
 * - Reconnect when the client reports `needsResync`, which is the repair for a
 *   gap and for a broken chunk stream alike.
 * - Reconnect when a submission goes unacknowledged for too long. This is the
 *   cheap answer to the production stall recorded in
 *   `evidence/workerd/results.md`: a sustained run against Cloudflare stopped
 *   waiting for an acknowledgement, four hypotheses were tested and none was
 *   it. A watchdog makes it self-healing whatever the cause turns out to be,
 *   which is worth more than the diagnosis.
 * - Nudging on local work, by subscribing to the store rather than by asking
 *   every caller to remember.
 * - Stopping for good when the host reports a dial can never succeed
 *   (`denied`). A permanent credential refusal is not a transport failure, and
 *   retrying it on a timer is a hot loop against a wall; the repair is a new
 *   app generation, which the host owns (reload on auth change), not a state
 *   in this driver.
 *   once, after the driver has let go of everything, and the host discards
 *   the local file whole and reloads. Nothing else can trigger it: a close
 *   without the announcement, garbage, and every failure are ordinary
 *   weather and reconnect on backoff, which is what makes "doubt never
 *   discards" structural.
 */
import { Ok, type Result } from 'wellcrafted/result';

import { type AccountDocument, syncEngineOf } from '../store/store.js';
import {
	createSyncClient,
	type Schedule,
	type SyncClient,
	type SyncClientError,
	type SyncClientStatus,
	type SyncSocket,
} from './client.js';

/**
 * One attempt at a connection, from the host's point of view.
 *
 * The host is handed the position to ask from and three callbacks, and hands
 * back whatever tears its socket down. Every callback is safe to call from a
 * stale attempt: this file checks, so a host does not have to.
 */
export type SyncAttempt = {
	/**
	 * The position to ask the authority to start after. Belongs in the URL.
	 *
	 * Read fresh on every attempt from what this replica has applied, which is
	 * what makes a reconnect a catch-up rather than a fresh start. At boot
	 * that is exactly what the durable record recovered; mid-session it may
	 * run ahead of a blocked durable copy, and a restart then re-fetches from
	 * the applied cursor, which is safe because an update is idempotent
	 * (ADR-0238).
	 */
	readonly cursor: number;
	/** The socket is live and can carry bytes. */
	opened(socket: SyncSocket): void;
	/** Bytes arrived from the authority. */
	received(bytes: Uint8Array): void;
	/** The socket is gone, for any reason. Safe to call more than once. */
	closed(): void;
	/**
	 * No socket this host can make will ever succeed. Stops the driver for good.
	 *
	 * The one report that is not a transport failure: a credential model that
	 * permanently refuses to open a socket (signed out, reauth required, a
	 * window that holds no credential at all) cannot be repaired by time-based
	 * retry, so `closed()` would spin the backoff forever against a refusal.
	 * The driver releases everything it holds and never dials again; sync for
	 * this replica resumes only in a new app generation, which the host starts
	 * by reloading on an auth change.
	 */
	denied(): void;
};

/**
 * How this host makes a socket. The whole of what a host has to write.
 *
 * Returns a teardown. It is called when this driver has decided to abandon the
 * attempt, and it must be safe to call on a socket that already closed.
 */
export type SyncDial = (attempt: SyncAttempt) => () => void;

/** Why the driver last decided to reconnect. Diagnostic, never control flow. */
export type ReconnectReason =
	/** The socket closed, whether cleanly or not. */
	| 'closed'
	/** The client is stuck behind a gap and asked to be reconnected. */
	| 'resync'
	/** A submission went unacknowledged past the watchdog's patience. */
	| 'stalled';

export type SyncConnectionStatus = SyncClientStatus & {
	/** Whether a socket is currently attached. */
	connected: boolean;
	/**
	 * Whether the host reported that no dial can ever succeed.
	 *
	 * Once true it stays true: the driver has let go of everything and this
	 * connection is permanently idle. A surface that renders sync should treat
	 * a denied connection the same as no connection at all.
	 */
	denied: boolean;
	/**
	 * Failed attempts since the last one that stayed up long enough to count.
	 *
	 * What the backoff is computed from, and the one number that says "this
	 * device is not talking to anything" without needing an error to have been
	 * produced.
	 */
	attempts: number;
	/** Why the last reconnect happened, or undefined if none has. */
	lastReconnect: ReconnectReason | undefined;
};

export type SyncConnection = {
	/** Start dialling. Idempotent. */
	start(): void;
	/** Send whatever is owed, now, rather than on the idle timer. */
	flush(): Result<void, SyncClientError>;
	status(): SyncConnectionStatus;
	/** Stop dialling and let go of the socket. */
	[Symbol.dispose](): void;
};

/**
 * The default backoff: double from a second, capped at half a minute.
 *
 * Capped rather than unbounded because the thing on the other end is a Durable
 * Object that hibernates and wakes, so "unreachable" is routinely a few seconds
 * rather than an outage, and a replica that has backed off to minutes would sit
 * out a recovery that already happened.
 */
function defaultBackoff(attempts: number): number {
	return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempts - 1));
}

export function createSyncConnection({
	store,
	dial,
	idleMs,
	schedule = (task, delayMs) => {
		const handle = setTimeout(task, delayMs);
		return () => clearTimeout(handle);
	},
	backoff = defaultBackoff,
	/**
	 * How long a socket must stay up before it counts as a working connection.
	 *
	 * The backoff resets here rather than on `opened`, and the difference
	 * matters: a server that accepts the upgrade and immediately closes, which
	 * is what a rejected credential or an overloaded authority looks like, would
	 * otherwise reset the backoff on every attempt and turn it into a hot loop.
	 */
	healthyMs = 5_000,
	/**
	 * How long one submission may stay unacknowledged before the socket is
	 * treated as dead.
	 *
	 * Generous on purpose. The failure it catches is a submission that will
	 * never be answered, not a slow one, and the cost of being wrong is a
	 * reconnect that re-sends bytes the authority may already hold, which is
	 * free: an update is idempotent (`evidence/invariants.test.ts`).
	 */
	unacknowledgedMs = 30_000,
}: {
	store: AccountDocument;
	dial: SyncDial;
	idleMs?: number;
	schedule?: Schedule;
	backoff?: (attempts: number) => number;
	healthyMs?: number;
	unacknowledgedMs?: number;
}): SyncConnection {
	const client: SyncClient = createSyncClient({
		store,
		...(idleMs === undefined ? {} : { idleMs }),
		schedule,
	});

	let running = false;
	let disposed = false;
	let denied = false;
	let connected = false;
	let attempts = 0;
	let lastReconnect: ReconnectReason | undefined;
	/**
	 * Which attempt is the live one.
	 *
	 * Every callback a host holds carries the generation it was made for. A
	 * socket that closes after this driver has already moved on would otherwise
	 * detach the client from its replacement, which reads as a connection that
	 * silently stops carrying anything.
	 */
	let generation = 0;
	let teardown: (() => void) | undefined;
	let cancelRedial: (() => void) | undefined;
	let cancelHealthy: (() => void) | undefined;
	let cancelWatchdog: (() => void) | undefined;
	/** The submission the watchdog saw on its previous tick. */
	let watched: number | undefined;

	const stopLocalWork = syncEngineOf(store).onLocalWork(() => client.nudge());

	function cancelTimers(): void {
		cancelHealthy?.();
		cancelHealthy = undefined;
		cancelWatchdog?.();
		cancelWatchdog = undefined;
		watched = undefined;
	}

	/** Let go of the current socket, whatever state it is in. */
	function abandon(): void {
		generation += 1;
		cancelTimers();
		const stop = teardown;
		teardown = undefined;
		connected = false;
		client.detach();
		stop?.();
	}

	/**
	 * Abandon the current socket and dial again after the backoff.
	 *
	 * One path for all three reasons, because the repair is the same one in
	 * every case: ask the authority for everything after this replica's own
	 * cursor, which is the catch-up any returning device runs.
	 */
	function reconnect(reason: ReconnectReason): void {
		if (!running) return;
		lastReconnect = reason;
		abandon();
		attempts += 1;
		cancelRedial?.();
		cancelRedial = schedule(() => {
			cancelRedial = undefined;
			open();
		}, backoff(attempts));
	}

	/**
	 * Everything to check after the client has been handed something.
	 *
	 * `needsResync` is the reason this exists and the reason it runs after every
	 * single delivery rather than on a timer: the client sets it and then waits
	 * for someone to notice, and a randomised schedule showed that nobody does.
	 */
	function settle(): void {
		if (!running) return;
		if (client.status().needsResync) reconnect('resync');
	}

	/**
	 * Let go of everything, permanently. Shared by disposal and denial: the
	 * only difference between "the app is done with sync" and "sync can never
	 * work in this app generation" is which flag the status reports.
	 */
	function shutdown(): void {
		running = false;
		stopLocalWork();
		cancelRedial?.();
		cancelRedial = undefined;
		abandon();
		client.dispose();
	}

	function open(): void {
		if (!running || teardown !== undefined) return;
		const attempt = ++generation;
		const live = () => running && generation === attempt;

		teardown = dial({
			cursor: client.cursor(),
			opened(socket: SyncSocket) {
				if (!live()) return;
				connected = true;
				client.attach(socket);
				// A socket that lasts is what proves the far end works. Anything
				// shorter is an attempt that failed in a way that happens to include
				// a successful upgrade.
				cancelHealthy = schedule(() => {
					cancelHealthy = undefined;
					attempts = 0;
				}, healthyMs);
				startWatchdog();
				settle();
			},
			received(bytes: Uint8Array) {
				if (!live()) return;
				client.receive(bytes);
				settle();
			},
			closed() {
				if (!live()) return;
				reconnect('closed');
			},
			denied() {
				if (!live()) return;
				denied = true;
				shutdown();
			},
		});
		// The attempt may have ended during dial() itself: a host that fails
		// synchronously reports `closed` or `denied` before the teardown above is
		// assigned, so the abandonment already ran and this assignment would
		// otherwise resurrect a dead attempt and block every future redial.
		if (generation !== attempt) {
			const stop = teardown;
			teardown = undefined;
			stop?.();
		}
	}

	/**
	 * Watch for a submission that is never going to be answered.
	 *
	 * It compares the submission NUMBER across ticks rather than the `inFlight`
	 * flag. Only one submission is ever out and the next starts the moment the
	 * previous is acknowledged, so under sustained local work the flag is
	 * continuously true on a completely healthy client, and a watchdog reading
	 * it would reconnect a working device every interval.
	 */
	function startWatchdog(): void {
		const tick = () => {
			cancelWatchdog = undefined;
			if (!running || !connected) return;
			const submission = client.status().inFlightSubmission;
			if (submission !== undefined && submission === watched) {
				watched = undefined;
				reconnect('stalled');
				return;
			}
			watched = submission;
			cancelWatchdog = schedule(tick, unacknowledgedMs);
		};
		watched = client.status().inFlightSubmission;
		cancelWatchdog = schedule(tick, unacknowledgedMs);
	}

	return Object.freeze({
		start() {
			if (disposed || denied || running) return;
			running = true;
			open();
		},

		flush() {
			if (disposed || denied) return Ok(undefined);
			return client.flush();
		},

		status(): SyncConnectionStatus {
			return {
				...client.status(),
				connected,
				denied,
				attempts,
				lastReconnect,
			};
		},

		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			if (!denied) shutdown();
		},
	});
}
