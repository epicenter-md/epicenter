/**
 * What a replica still owes the authority, computed from a vector it keeps
 * itself.
 *
 * The outbox answers this today by remembering the bytes: every locally
 * authored append is a durable row until an acknowledgement names it. That is
 * exact and it is the last reason a document's durable record is a chain
 * rather than one value. This computes the same answer from the document plus
 * one small vector, which is what lets a document become one value.
 *
 * ## The objection this has to survive
 *
 * `ClientLog` says, in its own words, "there is no state vector here, and that
 * absence is the design. A state vector cannot express deletion, so it can
 * never answer 'have I seen everything'." That is true and it is about the
 * other direction. Asking "has anything happened that I have not seen" cannot
 * be answered by comparing vectors, because a delete moves no clock; two
 * documents that disagree about a key hold identical vectors
 * (`evidence/invariants.test.ts`). Asking "what do I have that a receiver at
 * this vector does not" is a different question, and `encodeStateAsUpdateV2`
 * answers it while writing the whole delete set regardless of the vector, so
 * deletions are carried and never inferred. The evidence file already pins
 * both halves.
 *
 * ## The hazard, which is real and is waste rather than loss
 *
 * A vector that lags does not under-send; it over-sends, and the bytes it
 * over-sends are the ones that arrived FROM the authority. `log.ts` names that
 * cost precisely: re-offering received bytes "would grow the log with nothing
 * new in it". So a replica folds what arrived into its own vector as it
 * applies it, and then owes the empty update rather than a copy of someone
 * else's work.
 *
 * ## The ordering rule
 *
 * Advance the vector only after the bytes it accounts for are durable, and
 * only after the authority has acknowledged them. A vector that lags re-sends,
 * which is free because an update is idempotent. A vector that leads loses
 * authored work silently, forever, with nothing to notice it. Every window is
 * arranged to fall on the first side.
 */
import * as Y from '@y/y';

/** A replica's own record of what the authority already holds. */
export type SentVector = Uint8Array;

/** The vector of a replica that has handed over nothing. */
export function emptySentVector(): SentVector {
	return new Uint8Array(Y.encodeStateVector(new Map<number, number>()));
}

/** Everything in this document that a receiver at `sent` does not have. */
export function owedSince(document: Y.Doc, sent: SentVector): Uint8Array {
	return new Uint8Array(Y.encodeStateAsUpdateV2(document, sent));
}

/** Where this document stands right now, for recording after an acknowledgement. */
export function vectorOf(document: Y.Doc): SentVector {
	return new Uint8Array(Y.encodeStateVector(document));
}

/**
 * The vector describing what an update carries.
 *
 * Used on the receiving side: bytes that arrived from the authority are bytes
 * the authority has, so folding this in is what stops them being offered back.
 */
export function vectorOfUpdate(update: Uint8Array): SentVector {
	return new Uint8Array(Y.encodeStateVectorFromUpdateV2(update));
}

/**
 * The later of two vectors, clock by clock.
 *
 * Union rather than replacement, because the two are answers to different
 * questions that are both true: one says what the authority acknowledged
 * receiving from here, the other says what it sent from elsewhere. Taking the
 * maximum per client is what makes "the authority has this" the whole meaning
 * of the value.
 */
export function mergeSentVectors(
	left: SentVector,
	right: SentVector,
): SentVector {
	const merged = new Map(Y.decodeStateVector(left));
	for (const [client, clock] of Y.decodeStateVector(right)) {
		if ((merged.get(client) ?? 0) < clock) merged.set(client, clock);
	}
	return new Uint8Array(Y.encodeStateVector(merged));
}
