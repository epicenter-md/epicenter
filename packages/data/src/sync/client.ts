/**
 * The client half of the transport: coalesce, send, wait for the ack.
 *
 * It owns no socket and no reconnect policy. A caller hands it a socket that
 * can `send`, feeds it whatever arrives, and tells it when the socket is gone.
 * That keeps every timing rule in this file testable without a network, which
 * matters more than usual here: a previous cursor rule on this branch "worked"
 * in a simulation where nothing was ever delivered.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import type { ReplicaStore } from '../store/store.js';
import {
	CHUNK_BYTES,
	createChunkCollector,
	decodeFrame,
	encodeFrame,
	intoChunks,
} from './frames.js';

export const SyncClientError = defineErrors({
	/**
	 * The authority refused bytes this replica authored.
	 *
	 * Terminal for the submission and deliberately loud. The work is still held,
	 * so nothing is lost, but a replica whose writes the authority will not take
	 * is not syncing and must not look like it is.
	 */
	Refused: ({ reason }: { reason: string }) => ({
		message: `The authority refused this replica's update: ${reason}`,
		reason,
	}),
	/**
	 * An entry arrived that is not the next one.
	 *
	 * The log is a total order and a replica reads it in order, so a jump means
	 * something was dropped. Applying past it would make the loss permanent and
	 * silent, which is precisely the failure mode that has to stay impossible.
	 */
	Gap: ({ expected, received }: { expected: number; received: number }) => ({
		message: `Expected entry ${expected} and received ${received}`,
		expected,
		received,
	}),
	/**
	 * An entry arrived that this replica cannot apply.
	 *
	 * The poison pill, seen from the only place it is ever visible. The cursor
	 * does not move, so the replica is stuck here and will be stuck here on every
	 * reconnect, forever, until someone neutralises that position in the
	 * authority's log. Naming the position is what makes that a one-row repair
	 * rather than an unexplained device that stopped syncing.
	 */
	/**
	 * The frames arriving no longer add up to anything this replica can use.
	 *
	 * Chunks that contradict their own count, or a partial left behind by a dead
	 * socket colliding with a later frame at the same position. It is silent by
	 * nature: the reassembly simply never completes, so the replica stops moving
	 * while every layer reports success. Recovery is the reconnect a gap needs.
	 */
	BrokenStream: ({ reason }: { reason: string }) => ({
		message: `This replica cannot reassemble what it is being sent: ${reason}`,
		reason,
	}),
	Unapplyable: ({ seq, cause }: { seq: number; cause: unknown }) => ({
		message: `Entry ${seq} could not be applied, and this replica is stuck at ${seq - 1}`,
		seq,
		cause,
	}),
});
export type SyncClientError = InferErrors<typeof SyncClientError>;

/** Whatever carries bytes. A `WebSocket` satisfies this. */
export type SyncSocket = { send(bytes: Uint8Array): void };

export type SyncClientStatus = {
	/** How far through the authority's log this replica has read. */
	cursor: number;
	/** Whether a submission is out and waiting for its position. */
	inFlight: boolean;
	/**
	 * Which submission is out, or undefined when none is.
	 *
	 * `inFlight` alone cannot tell a stalled client from a busy one. Only one
	 * submission is ever out, and the next starts the moment the previous is
	 * acknowledged, so under sustained local work `inFlight` is continuously
	 * true while everything is perfectly healthy. A watchdog needs to know that
	 * the SAME submission is still out, which is what this number says.
	 */
	inFlightSubmission: number | undefined;
	/** Bytes this replica owes the authority, at the last coalesce. */
	owed: number;
	lastError: SyncClientError | undefined;
	/**
	 * Whether the document is holding updates whose dependencies never arrived.
	 *
	 * Reads as an alarm rather than as a state. Entries are applied in log order
	 * and the log is causally complete, so after a contiguous read this is false;
	 * true means the transport delivered something it should not have been able
	 * to, and no other layer will say so.
	 */
	unresolvedDependencies: boolean;
	/**
	 * Whether this replica is stuck and needs to be reconnected.
	 *
	 * A gap means an entry was dropped, and the cursor deliberately does not move
	 * past it, so every later entry is also a gap and the replica silently stops
	 * syncing forever. It set an error and waited for someone to notice, which a
	 * randomised schedule showed nobody does: a device wedged at position 108
	 * kept receiving 118, 119, 121 and rejecting all of them.
	 *
	 * Recovery is a reconnect, which asks the authority for everything after this
	 * replica's own cursor and is the same catch-up any returning device runs.
	 * The caller owns the socket, so the caller has to do it; this is how it
	 * finds out.
	 */
	needsResync: boolean;
	/**
	 * The CLIENT's conclusion from the announcement (ADR-0231): this
	 * replica's document was replaced, and sync is over for good.
	 *
	 * Drawn only when the authority, on this replica's own authenticated
	 * socket, named a document that is not the one this replica's state
	 * durably belongs to. Any other frame, close, or failure leaves it
	 * false, which is what makes "doubt never discards" structural. Sticky
	 * once true, in the same set-and-wait shape as `needsResync`: the driver
	 * notices, stops for good, and the host discards the local file whole
	 * and reloads.
	 */
	superseded: boolean;
};

export type SyncClient = {
	/** The position to ask the authority to start from. Goes in the URL. */
	cursor(): number;
	/**
	 * Which authority document this replica's state belongs to, or undefined
	 * for one that never exchanged a byte. Goes in the URL beside the cursor
	 * (ADR-0231).
	 *
	 * The membership fact the cursor cannot carry. Admission is equality on
	 * it: the cursor says only how far through THAT document's log this
	 * replica has read.
	 */
	document(): string | undefined;
	/** A socket is live. Anything owed goes out now. */
	attach(socket: SyncSocket): void;
	/** The socket is gone. Whatever was in flight is owed again. */
	detach(): void;
	/** Local work happened. Sends after the idle interval. */
	nudge(): void;
	/** Send whatever is owed, now. */
	flush(): Result<void, SyncClientError>;
	/** Bytes arrived from the authority. */
	receive(message: Uint8Array): Result<void, SyncClientError>;
	status(): SyncClientStatus;
	dispose(): void;
};

/** Cancelable delayed work, injected so tests do not wait in real time. */
export type Schedule = (task: () => void, delayMs: number) => () => void;

const defaultSchedule: Schedule = (task, delayMs) => {
	const handle = setTimeout(task, delayMs);
	return () => clearTimeout(handle);
};

export function createSyncClient({
	store,
	/**
	 * How long local work waits before it is sent.
	 *
	 * The whole 30x. One update per transaction grew the authority's log to
	 * 1,261 MB over a decade in simulation and roughly a second of coalescing
	 * brought that to 40 MB, which is what made refusing compaction affordable
	 * (`evidence/bench/never-compact.ts`). It is an idle timer rather than a
	 * fixed batch because it is the same interval an editor debounces on anyway.
	 */
	idleMs = 1_000,
	schedule = defaultSchedule,
	/** Guards the authority's in-memory reassembly, and mirrors its limit. */
	maxBufferedBytes = 64 * 1024 * 1024,
}: {
	store: ReplicaStore;
	idleMs?: number;
	schedule?: Schedule;
	maxBufferedBytes?: number;
}): SyncClient {
	// Rebuilt on every attach rather than held for the life of the client. A
	// collector keyed by position outliving its socket is how a partial left by a
	// dead connection collides with a later frame at the same number.
	let collector = createChunkCollector({ limitBytes: maxBufferedBytes });
	let socket: SyncSocket | undefined;
	let inFlight: { submission: number; throughId: number } | undefined;
	let nextSubmission = 1;
	let cursor = store.sync.cursor().data ?? 0;
	/** The document this replica's state durably belongs to, if any. */
	let identity = store.sync.documentIdentity().data ?? undefined;
	let owed = 0;
	let lastError: SyncClientError | undefined;
	let needsResync = false;
	let superseded = false;
	let cancelIdle: (() => void) | undefined;
	let disposed = false;

	function clearIdle(): void {
		cancelIdle?.();
		cancelIdle = undefined;
	}

	function send(): Result<void, SyncClientError> {
		// One submission at a time. Two in flight would make an ack ambiguous
		// about which outbox entries it retires, and the outbox is the only record
		// that work is still owed.
		if (socket === undefined || inFlight !== undefined) return Ok(undefined);

		const { data: entry, error } = store.sync.coalesce();
		if (error !== null) return Ok(undefined);
		if (entry === undefined) {
			owed = 0;
			return Ok(undefined);
		}
		owed = entry.bytes.length;

		// No push ever leaves an unstamped replica (ADR-0231). Once these bytes
		// are on the wire they may land in the authority's log while the ack
		// dies with the socket, and membership in that log is a fact the cursor
		// cannot record. The stamp commits when the document frame is handled,
		// which on a bootstrap connection precedes admission itself; until then
		// the work stays owed and goes out on a later nudge, which is the safe
		// direction.
		if (identity === undefined) return Ok(undefined);

		const submission = nextSubmission;
		nextSubmission += 1;
		inFlight = { submission, throughId: entry.id };
		const chunks = intoChunks(entry.bytes, CHUNK_BYTES);
		for (const [index, chunk] of chunks.entries()) {
			socket.send(
				encodeFrame({
					kind: 'push',
					submission,
					chunk: index,
					chunks: chunks.length,
					bytes: chunk,
				}),
			);
		}
		return Ok(undefined);
	}

	/** Report a reassembly failure and ask to be reconnected. */
	function brokenStream(reason: string): Result<void, SyncClientError> {
		const broken = SyncClientError.BrokenStream({ reason });
		lastError = broken.error;
		needsResync = true;
		return broken;
	}

	function apply(
		seq: number,
		bytes: Uint8Array,
	): Result<void, SyncClientError> {
		// Already applied. Re-delivery is not an error, it is a design property
		// the transport leans on in three places: a crash between committing
		// bytes and advancing the cursor re-sends, a reconnect re-sends whatever
		// was in flight, and a hibernating Durable Object wakes holding a
		// position that is BEHIND what it really sent and deliberately re-sends
		// from there. Reporting a gap here made the recovery path look like data
		// loss, and a randomised schedule hit it within a few dozen rounds.
		if (seq <= cursor) return Ok(undefined);
		if (seq !== cursor + 1) {
			// Never applied, and the cursor never moves. The caller's repair is to
			// reconnect from `cursor`, which is a catch-up and the same code path
			// the authority already runs.
			const gap = SyncClientError.Gap({ expected: cursor + 1, received: seq });
			lastError = gap.error;
			needsResync = true;
			return gap;
		}
		// Bytes and bookmark in ONE transaction (ADR-0231). The old shape was
		// bytes-first-cursor-after in two commits, and the crash between them
		// manufactured a replica durably holding another document's bytes while
		// presenting a fresh install's dial, which admission would greet and
		// merge across the break. Atomicity keeps re-delivery free (a crash
		// leaves neither); the membership stamp is already durable, because a
		// frame like this one is dropped until it is.
		const { error } = store.applyRemote(bytes, { advanceTo: seq });
		if (error !== null) {
			// The cursor does not move, so nothing is skipped and nothing is lost.
			// But this replica is now stuck at this position on every reconnect
			// forever, which is the whole poison-pill failure, and it has to be
			// LOUD. Swallowing it here was worse than the pill: the device simply
			// stopped syncing and every layer reported success.
			const stuck = SyncClientError.Unapplyable({ seq, cause: error });
			lastError = stuck.error;
			return stuck;
		}
		cursor = seq;
		return Ok(undefined);
	}

	/**
	 * Take the authority's snapshot, and move this replica's cursor to it.
	 *
	 * The ONE place a cursor may jump. Everywhere else a position that is not
	 * the next one is refused, because a gap in the log is data nobody will ever
	 * mention again; here the jump is safe for a reason that has nothing to do
	 * with trust: the snapshot covers every position at or before it, so there
	 * is nothing in the skipped range that these bytes do not already carry.
	 *
	 * It MERGES rather than replaces. The snapshot preserves struct identities,
	 * so unsent offline work survives and goes out afterwards like any other
	 * local write.
	 */
	function adopt(
		position: number,
		bytes: Uint8Array,
	): Result<void, SyncClientError> {
		if (position <= cursor) return Ok(undefined);
		const { error } = store.applyRemote(bytes, { advanceTo: position });
		if (error !== null) {
			const stuck = SyncClientError.Unapplyable({
				seq: position,
				cause: error,
			});
			lastError = stuck.error;
			return stuck;
		}
		cursor = position;
		return Ok(undefined);
	}

	/**
	 * Answer a request for a snapshot with this replica's whole state.
	 *
	 * Refused unless this replica is exactly at the position asked for, and
	 * unless it is holding no update whose dependencies never arrived. Both
	 * would produce a snapshot missing data, and a snapshot replaces history
	 * rather than adding to it, so what it misses is gone for everybody.
	 */
	function offerSnapshot(position: number): Result<void, SyncClientError> {
		if (socket === undefined || position !== cursor) return Ok(undefined);
		if (store.hasUnresolvedDependencies()) return Ok(undefined);
		const chunks = intoChunks(store.encodeStateSince(), CHUNK_BYTES);
		for (const [index, chunk] of chunks.entries()) {
			socket.send(
				encodeFrame({
					kind: 'offer',
					position,
					chunk: index,
					chunks: chunks.length,
					bytes: chunk,
				}),
			);
		}
		return Ok(undefined);
	}

	return Object.freeze({
		cursor: () => cursor,

		document: () => identity,

		attach(next: SyncSocket) {
			socket = next;
			// A new socket starts a new reassembly. Whatever the old one left half
			// delivered is being re-sent from this replica's cursor anyway, and
			// keeping it could only collide.
			collector = createChunkCollector({ limitBytes: maxBufferedBytes });
			// A fresh socket asks from this replica's own cursor, which is exactly
			// the repair a gap needs.
			needsResync = false;
			// Whatever was in flight was never acknowledged, so it is owed again.
			// The authority may well have stored it; a second copy costs log bytes
			// and changes nothing, because an update is idempotent.
			inFlight = undefined;
			send();
		},

		detach() {
			socket = undefined;
			inFlight = undefined;
			collector = createChunkCollector({ limitBytes: maxBufferedBytes });
			clearIdle();
		},

		nudge() {
			if (disposed || cancelIdle !== undefined) return;
			cancelIdle = schedule(() => {
				cancelIdle = undefined;
				send();
			}, idleMs);
		},

		flush() {
			clearIdle();
			return send();
		},

		receive(message: Uint8Array): Result<void, SyncClientError> {
			const { data: frame, error } = decodeFrame(message);
			if (error !== null) return Ok(undefined);
			// A superseded replica takes nothing more. The conclusion is
			// terminal, the driver is about to tear everything down, and bytes
			// arriving after it must not be merged into a document that is
			// already declared to belong elsewhere.
			if (superseded) return Ok(undefined);

			switch (frame.kind) {
				case 'ack': {
					if (
						inFlight === undefined ||
						frame.submission !== inFlight.submission
					) {
						return Ok(undefined);
					}
					// The authority relays to every other socket before it answers this
					// one, and a socket delivers in order, so everything below this
					// position has already been applied. Checking rather than assuming
					// is the point: if it is ever false the ordering assumption is
					// wrong, and a cursor that advanced anyway would skip real entries.
					if (frame.seq === cursor + 1) {
						store.sync.advance(frame.seq);
						cursor = frame.seq;
					} else if (frame.seq > cursor + 1) {
						lastError = SyncClientError.Gap({
							expected: cursor + 1,
							received: frame.seq,
						}).error;
						needsResync = true;
					}
					store.sync.acknowledge(inFlight.throughId);
					inFlight = undefined;
					owed = 0;
					// Work authored while that submission was out is still owed.
					send();
					return Ok(undefined);
				}
				case 'refuse': {
					// Only if it answers the submission actually in flight. The ack
					// path has always checked this and the refusal path did not, so a
					// refusal aimed at a snapshot offer, which carries a position
					// rather than a submission number, was read as a refusal of an
					// unrelated push and cleared it.
					if (
						inFlight === undefined ||
						frame.submission !== inFlight.submission
					) {
						return Ok(undefined);
					}
					const refused = SyncClientError.Refused({ reason: frame.reason });
					lastError = refused.error;
					// The outbox is NOT cleared. The authority has taken no
					// responsibility for these bytes, so this replica keeps holding
					// them, and a refusal that repeats is visible rather than a write
					// that quietly disappeared.
					inFlight = undefined;
					return refused;
				}
				case 'entry': {
					// An unstamped replica takes no foreign bytes. The document frame
					// precedes everything on a well-behaved connection, so this is
					// unreachable against a real authority; against anything else it
					// is what keeps "persisted state and persisted document ID never
					// disagree" structural rather than assumed (ADR-0231).
					if (identity === undefined) return Ok(undefined);
					const { data: whole, error: chunkError } = collector.accept(frame);
					// A reassembly failure is NOT nothing. It means this replica's view
					// of the stream is broken, and returning Ok here left it stalled
					// with no error, no `needsResync`, and every layer reporting
					// success. Recovery is the same reconnect a gap needs.
					if (chunkError !== null) return brokenStream(chunkError.reason);
					if (whole === undefined) return Ok(undefined);
					return apply(frame.seq, whole);
				}
				case 'snapshot': {
					if (identity === undefined) return Ok(undefined);
					const { data: whole, error: chunkError } = collector.accept(frame);
					if (chunkError !== null) return brokenStream(chunkError.reason);
					if (whole === undefined) return Ok(undefined);
					return adopt(frame.position, whole);
				}
				case 'wanted':
					return offerSnapshot(frame.position);
				case 'document':
					// The authority names its document; the conclusion is this
					// replica's to draw. A different name than the one this
					// replica's state belongs to is the whole of supersession: no
					// ordering arithmetic, one inequality on an authenticated
					// socket, which is what makes "doubt never discards"
					// structural (no failure can fabricate a typed frame).
					if (identity !== undefined && identity !== frame.id) {
						superseded = true;
						return Ok(undefined);
					}
					// The one stamping point. The stamp itself refuses a store that
					// grew before it was stamped (`Unstampable`), which is a
					// defensive assertion at the bootstrap boundary rather than a
					// product concept: a workspace replica is never allowed to grow
					// before it adopts the authority's document, and the application
					// enforces that by keeping an unbound signed-in workspace
					// unavailable. Bytes that exist here anyway belong to no
					// authority document and are not a merge case, so the refusal
					// concludes `superseded` and the host discards them and starts
					// again. The stamp commits durably before any foreign byte is
					// applied and before any push can leave, because both are refused
					// while `identity` is undefined.
					if (identity === undefined) {
						const { error: stampError } = store.sync.adoptDocumentIdentity(
							frame.id,
						);
						if (stampError !== null) {
							// A storage failure leaves the replica unstamped to try again
							// at the next announcement; only the refusal is a conclusion.
							if (stampError.name === 'Unstampable') superseded = true;
							return Ok(undefined);
						}
						identity = frame.id;
					}
					return Ok(undefined);
				case 'push':
				case 'offer':
					// A client never receives either. Ignored rather than thrown on,
					// because a throw here would be swallowed by the socket runtime.
					return Ok(undefined);
			}
		},

		status: () => ({
			cursor,
			inFlight: inFlight !== undefined,
			inFlightSubmission: inFlight?.submission,
			owed,
			lastError,
			unresolvedDependencies: store.hasUnresolvedDependencies(),
			needsResync,
			superseded,
		}),

		dispose() {
			disposed = true;
			clearIdle();
			socket = undefined;
		},
	});
}
