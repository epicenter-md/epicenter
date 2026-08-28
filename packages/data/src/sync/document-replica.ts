/**
 * One document on a device: a `Y.Doc`, a blob it is written to, and the two
 * calls the sync protocol needs.
 *
 * The client half of ADR-0277, and what is notable is what is absent. There is
 * no cursor, because there are no positions. There is no outbox, because a
 * replica does not remember what it owes: it offers its state vector and is
 * told. There is no identity here, because the generation is a segment of the
 * key and a replica reading the wrong generation is reading a different key
 * (ADR-0276). What is durable is the document and nothing beside it, so there
 * is nothing that has to land atomically with anything.
 *
 * ## Why persisting is explicit
 *
 * `persist()` is a call the owner makes, not something that happens on every
 * transaction. Writing the whole document per keystroke is O(document) per
 * edit, and the thing that makes that acceptable is a debounce the owner
 * already has for sending. Persisting on a timer the owner controls keeps both
 * on one clock; persisting in here would put a second, invisible one beside it.
 *
 * ## The ordering rule, and it is the only one
 *
 * Bytes are made durable before anything says they were sent. A replica that
 * persists late re-sends work the authority already has, which is free because
 * an update is idempotent. A replica that persists never, and reports having
 * sent, loses authored work silently. Every window here falls on the first
 * side, and the reason it is easy to keep is that there is only one durable
 * fact left to order.
 */
import * as Y from '@y/y';

import type { Blobs } from '../store/blobs.js';

export type DocumentReplica = {
	/** The live document. Truth while open (ADR-0238). */
	readonly document: Y.Doc;
	/** Sync step 1: what this replica holds. */
	stateVector(): Uint8Array;
	/** Sync step 2, outbound: everything a peer at `peerVector` lacks. */
	since(peerVector?: Uint8Array): Uint8Array;
	/** Sync step 2, inbound, or a relayed update. Both are the same call. */
	receive(update: Uint8Array): void;
	/** Write the whole document to its key. Whole, and atomically. */
	persist(): Promise<void>;
	dispose(): void;
};

/**
 * Open one document from durable storage.
 *
 * A key that has never been written is an empty document rather than a
 * failure: a replica that has never synced and a replica whose document is
 * genuinely empty are the same replica, and the protocol tells them apart by
 * asking rather than by a flag either of them stores.
 */
export async function openDocumentReplica({
	blobs,
	key,
}: {
	blobs: Blobs;
	key: string;
}): Promise<DocumentReplica> {
	const document = new Y.Doc({ gc: true });
	const stored = await blobs.read(key);
	if (stored !== undefined) Y.applyUpdateV2(document, stored);

	const replica: DocumentReplica = Object.freeze({
		document,
		stateVector: () => new Uint8Array(Y.encodeStateVector(document)),
		since: (peerVector?: Uint8Array) =>
			new Uint8Array(Y.encodeStateAsUpdateV2(document, peerVector)),
		receive(update: Uint8Array) {
			Y.applyUpdateV2(document, update);
		},
		persist: () =>
			blobs.write(key, new Uint8Array(Y.encodeStateAsUpdateV2(document))),
		dispose() {
			document.destroy();
		},
	});
	return replica;
}
