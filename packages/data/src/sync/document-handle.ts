/**
 * One open document, owning everything about being open.
 *
 * The thing that replaces a control plane. `documents.ts` describes itself as
 * a manager that "reuses one live `Y.Doc` per address, persists through the
 * store's ONE durable queue, accepts remote bytes from the store's ONE
 * connection", and every "one" in that sentence was true of a positional log
 * carried on a single socket. Under one object per document (ADR-0277) none of
 * them is, and what is left for a manager to do is hold a map.
 *
 * So a handle owns its own lifetime instead: its document, its claim on one
 * chain, its socket, and its timer. Closing it ends all four. It does not own
 * the record, which serves every document in the store and outlives any one
 * handle. Nothing has to enumerate open documents to persist them, because
 * nothing has to persist them.
 *
 * ## The root document is one of these
 *
 * It is the handle nobody closes. That is the entire difference between the
 * application document and a note's body: one is opened when the database
 * opens and closed when it closes, and the other is opened when somebody looks
 * at a note. Same type, same lifecycle, different lifetime.
 *
 * ## Two clocks would be one too many, and there is one
 *
 * An earlier version of this file said the durable write and the push "are the
 * same moment" and fired both on the timer. They are not, and saying so cost a
 * person's unsaved work: appending is O(update) and is what makes an edit
 * durable, so it happens on every update with nothing in front of it, while
 * folding and pushing are O(document) and only ever shorten a replay or catch
 * a peer up. Those two share the timer (ADR-0280).
 *
 * The one ordering that still matters is inside `settle`: fold before push
 * would be harmless, but telling a peer about bytes this device might not have
 * on its next boot is the direction that loses work silently. Under eager
 * appends that is satisfied by construction, because the bytes were durable
 * before the timer ever ran.
 *
 * ## Why opening is asynchronous
 *
 * `store.ts` already says it, and fast storage does not change it: "it is a
 * load, and a synchronous surface in front of one either forces eager loading
 * or hands out a half-hydrated handle an editor merges keystrokes into at the
 * wrong position." A ProseMirror editor bound to a `Y.Type` that is about to
 * have three thousand structs applied underneath it is wrong however briefly
 * it lasts.
 */
import * as Y from '@y/y';

import type { DurableRecord } from '../store/record.js';
import {
	type DocumentFrame,
	type DocumentSocket,
	decodeDocumentFrame,
	encodeDocumentFrame,
} from './document-frames.js';

/**
 * The origin a remote frame is applied under, so a stranger is not one.
 *
 * A listener on a handle's document has to tell three things apart: this
 * device's own commit, a frame this handle applied, and somebody calling
 * `Y.applyUpdateV2` on a document they got hold of. `transaction.local`
 * separates the first from the other two and cannot separate those, because a
 * frame applied with no origin looks exactly like a rogue apply.
 *
 * That mattered less under the old design and matters more now. The store used
 * to refuse an unrecognised origin outright, and the reason given was that
 * foreign bytes would be republished as this device's authored work. Nothing
 * is "authored" under state-vector sync, so that half expired. The other half
 * got worse: foreign bytes whose causal dependencies are missing are buffered
 * by Yjs, never emitted as an update, never appended to the chain, never in a
 * state vector, and held by no authority. Silently gone.
 *
 * So a frame carries this, and a listener asks for it rather than asking
 * whether the transaction was local.
 */
export const REMOTE_ORIGIN = Object.freeze({ kind: 'epicenter-remote' });

export type DocumentHandle = {
	/** The live document. Truth while open (ADR-0238). */
	readonly document: Y.Doc;
	/** What this replica holds, which is the peer question's other half. */
	stateVector(): Uint8Array;
	/**
	 * Everything a peer at `peerVector` does not have. Sync step 2.
	 *
	 * Public because two things outside the socket want it: the copy verb,
	 * which needs a document's whole state to write elsewhere, and the
	 * `?state-vector` read a dashboard uses to compute a difference without
	 * opening a socket (ADR-0283).
	 */
	since(peerVector?: Uint8Array): Uint8Array;
	/** A socket is live for this document. Says what this replica has. */
	attach(socket: DocumentSocket): void;
	/**
	 * Bytes arrived on that socket. Returns whether they were a frame.
	 *
	 * A host wires its socket's message event to this. The pair is deliberate
	 * and was missing for an hour: `attach` gives the handle somewhere to
	 * write, and this is where reading lands. A handle with only `attach` can
	 * talk and cannot listen, which a test caught by being unable to wire one.
	 */
	receive(message: Uint8Array): boolean;
	detach(): void;
	/** Fold if it is worth folding, then send what the peer lacks. */
	settle(): Promise<void>;
	/** Settle, then release the socket, the timer, and the document. */
	close(): Promise<void>;
	/**
	 * Let go WITHOUT settling, for a document whose chain is being deleted.
	 *
	 * The distinction from `close` is not tidiness, it is the difference
	 * between a folded chain and a resurrected one. `close` settles first, and
	 * settling folds: `fold` writes the encoded document above whatever is on
	 * disk NOW, so folding a chain that a retire has just swept writes the
	 * whole document back at sequence 1. The row is gone, nothing names the
	 * address, and the bytes sit there until `documents()` enumerates them for
	 * an export (ADR-0286) and a deleted note comes back.
	 *
	 * The timer reaches the same place on its own: `run` only checks `closed`,
	 * and a delete does not set it. So this is what a delete calls, and it is
	 * synchronous, so no append transaction can be created after it.
	 */
	discard(): void;
};

export type OpenDocumentHandleOptions = {
	record: DurableRecord;
	/** This document's key in the record: `app`, or `<table>/<rowId>`. */
	doc: string;
	/** How long work must stop arriving before folding and pushing. */
	idleMs?: number;
	/** Injected so a test can drive the timer rather than wait for it. */
	schedule?: (run: () => void, ms: number) => () => void;
};

const DEFAULT_IDLE_MS = 1_000;

const timeout: NonNullable<OpenDocumentHandleOptions['schedule']> = (
	run,
	ms,
) => {
	const id = setTimeout(run, ms);
	return () => clearTimeout(id);
};

export async function openDocumentHandle({
	record,
	doc,
	idleMs = DEFAULT_IDLE_MS,
	schedule = timeout,
}: OpenDocumentHandleOptions): Promise<DocumentHandle> {
	// Taken before anything is read. Two handles on one address would each fold
	// a state encoded from a document that never saw the other's edits, and the
	// delete range would sweep them: the record refuses rather than corrupts.
	const release = record.claim(doc);
	const document = new Y.Doc({ gc: true });

	try {
		// Hydrate before the listener exists, or every replayed update would be
		// appended straight back onto the chain it came from.
		for (const update of await record.read(doc)) {
			Y.applyUpdateV2(document, update);
		}
	} catch (cause) {
		// A transient read failure must not brick the address: without this the
		// claim outlives the failed open, and the retry is refused with "already
		// open in this record", which is both wrong and misleading.
		release();
		document.destroy();
		throw cause;
	}

	let socket: DocumentSocket | undefined;
	/**
	 * What the peer told us it had, at its last step 1.
	 *
	 * The only sync state here, and it is not durable on purpose. Losing it
	 * means re-announcing on the next attach, which is one extra handshake;
	 * persisting it would let a replica believe something about a peer it has
	 * not spoken to since, which is the class of stale fact the cursor was.
	 */
	let peerVector: Uint8Array | undefined;
	let cancelIdle: (() => void) | undefined;
	let closed = false;

	const stateVector = () => new Uint8Array(Y.encodeStateVector(document));
	const since = (peer?: Uint8Array) =>
		new Uint8Array(Y.encodeStateAsUpdateV2(document, peer));

	function send(frame: DocumentFrame): void {
		socket?.send(encodeDocumentFrame(frame));
	}

	/** Local work goes out as an update against what the peer last claimed. */
	function sendOwed(): void {
		if (socket === undefined || peerVector === undefined) return;
		send({ kind: 'update', update: since(peerVector) });
		// The peer has it once it is on the wire. If the socket dies in flight
		// the peer's next step 1 says otherwise and it is sent again, which is
		// free: an update is idempotent.
		peerVector = stateVector();
	}

	/**
	 * The settle in flight, so two never overlap.
	 *
	 * A timer-fired settle and a `close()` can otherwise both fold: the second
	 * sweeps the first's state record and subtracts a tail that is already
	 * gone, which drives the accounting negative and suppresses folds until it
	 * recovers. Nothing is lost either way, because the second state is a
	 * superset, but two folds is one fold of waste.
	 */
	let settling: Promise<void> | undefined;

	async function settle(): Promise<void> {
		if (settling !== undefined) return settling;
		settling = run();
		try {
			await settling;
		} finally {
			settling = undefined;
		}
	}

	async function run(): Promise<void> {
		cancelIdle?.();
		cancelIdle = undefined;
		if (closed) return;
		if (record.shouldFold(doc)) {
			// `encode` runs synchronously inside `fold`, before it opens its
			// transaction. That is the record's rule and it is why this is a
			// callback rather than bytes.
			await record.fold(doc, () => since());
		}
		sendOwed();
	}

	/**
	 * Everything `close` and `discard` agree on, which is everything but the
	 * settle. Idempotent: a discard during a close's in-flight fold, or a
	 * double close from a re-run effect teardown, must not throw.
	 */
	function letGo(): void {
		if (closed) return;
		closed = true;
		release();
		cancelIdle?.();
		cancelIdle = undefined;
		socket = undefined;
		peerVector = undefined;
		document.off('updateV2' as never, onUpdate as never);
		document.destroy();
	}

	function onUpdate(update: Uint8Array): void {
		if (closed) return;
		// Eager, and not awaited: the appends are ordered by the record because
		// it hands out sequences synchronously, and a rejection is reported
		// through `record.durability` rather than thrown at a Yjs listener that
		// has nowhere to put it.
		void record.append(doc, update).catch(() => undefined);
		cancelIdle?.();
		cancelIdle = schedule(() => {
			cancelIdle = undefined;
			// Swallowed for the same reason the append above is: a failing fold
			// has already reported itself through `record.durability`, and a
			// timer callback has nowhere to put a rejection.
			void settle().catch(() => undefined);
		}, idleMs);
	}

	// `updateV2` fires for remote applications too. Appending those is not
	// waste: bytes that arrived are bytes this device now holds, and a reload
	// that had to re-fetch them would ask for something it was already given.
	document.on('updateV2' as never, onUpdate as never);

	const handle: DocumentHandle = Object.freeze({
		document,
		stateVector,
		since,

		attach(next: DocumentSocket) {
			if (closed) return;
			socket = next;
			peerVector = undefined;
			send({ kind: 'step1', stateVector: stateVector() });
		},

		detach() {
			socket = undefined;
			peerVector = undefined;
		},

		receive(message: Uint8Array): boolean {
			if (closed) return false;
			const { data: frame, error } = decodeDocumentFrame(message);
			if (error !== null) return false;
			// Frames below apply under `REMOTE_ORIGIN`, never bare. A listener
			// outside this file tells a local commit from a remote one by that
			// origin rather than by `transaction.local`, which cannot tell a
			// frame from a stranger's direct `Y.applyUpdateV2`.
			switch (frame.kind) {
				case 'step1':
					// The peer said what it has, so answer with what it lacks and
					// remember the claim. This is also the moment this replica
					// learns enough to push: before it there is nothing to diff.
					peerVector = frame.stateVector;
					send({ kind: 'step2', update: since(frame.stateVector) });
					sendOwed();
					return true;
				case 'step2':
				case 'update': {
					// The frame decoded and its payload still may not be an update.
					// `decodeDocumentFrame` returns a `Result` because a peer is not
					// a caller, and applying bare here threw that reasoning away one
					// line later: it would come out of the host's socket message
					// handler, which has nowhere to put it.
					try {
						Y.applyUpdateV2(document, frame.update, REMOTE_ORIGIN);
					} catch {
						return false;
					}
					return true;
				}
			}
		},

		settle,

		async close() {
			// A failing fold must not turn a route change into an unhandled
			// rejection; it has already reported itself.
			await settle().catch(() => undefined);
			letGo();
		},

		discard() {
			// `closed` first, and synchronously: `run` reads it, so a timer that
			// has already fired and is awaiting its fold cannot start another,
			// and no `onUpdate` after this point arms a new one.
			letGo();
		},
	});
	return handle;
}
