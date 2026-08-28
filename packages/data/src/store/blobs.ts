/**
 * Where a workspace's bytes live: four methods, and not one of them knows what
 * Yjs is.
 *
 * A document is one value. Reading it is reading a key; writing it is writing
 * a key, whole. That is the entire storage contract, and everything that used
 * to sit above it, the update chain, the ids that ordered it, the fold that
 * collapsed it, and the queue that carried it, was machinery for storing a
 * document in pieces.
 *
 * ## Why this is smaller than the port it replaces
 *
 * `DurablePort` also had three methods, but each one carried log semantics:
 * `commit` took an ordered batch of four kinds of operation and had to apply
 * them atomically, and `readDocument` answered with a CHAIN to replay rather
 * than a value. Two implementations of that contract were written by hand and
 * they silently disagreed, which is why `port-conformance.test.ts` had to
 * exist. Nothing here can disagree about anything: a key holds the bytes last
 * written to it.
 *
 * ## Who chooses the implementation
 *
 * Not this package. ADR-0222 already settled the shape for the other resource
 * a runtime owns: "a host owns how to make a socket and the library owns
 * everything done with one." A host hands in a `Blobs`, so the store never
 * detects a capability and there is no build-time seam for storage. A browser
 * tab and the desktop host differ in exactly one object.
 *
 * ## What a caller may assume, and what it may not
 *
 * A `write` is ATOMIC: after it resolves, the key holds all of the new bytes,
 * and if it rejects or the process dies mid-write the key still holds all of
 * the old ones. Never a torn value. That matters more here than it did under a
 * log, because half a Yjs update parses as valid-and-wrong rather than failing
 * loudly.
 *
 * A write is NOT atomic ACROSS keys. Deleting a row touches the application
 * document and the row's own document, and a crash between them leaves bytes
 * no row names. That is debris rather than divergence: nothing opens a
 * document the application document does not mention, and a later pass can
 * collect it. Ordering is the invariant that has to hold, not atomicity, and
 * the ordering rule is the store's: write bytes before advancing the cursor.
 *
 * ## Failure
 *
 * Methods reject rather than answering a `Result`, which is what `DurablePort`
 * did and what its one caller, the persistence controller, is written for: a
 * failed flush retains its work and reports `blocked`. Threading a `Result`
 * through would give that caller a second shape to handle and no new
 * information.
 */

/** One store's durable bytes, keyed by document address. */
export type Blobs = {
	/** The bytes at `key`, or undefined when nothing has been written there. */
	read(key: string): Promise<Uint8Array | undefined>;
	/**
	 * Replace `key` with `bytes`, whole and atomically.
	 *
	 * Creates whatever the key implies. A partial write is never observable.
	 */
	write(key: string, bytes: Uint8Array): Promise<void>;
	/** Forget `key`. Idempotent: removing what is not there is success. */
	remove(key: string): Promise<void>;
	/**
	 * Every key at or below `prefix`, in no particular order.
	 *
	 * A prefix is a key prefix at segment boundaries, so `notes` matches
	 * `notes/abc` and never `notesy/abc`. The empty string matches everything.
	 */
	list(prefix: string): Promise<string[]>;
};

/**
 * Split a key into its path segments, refusing the shapes a store never mints.
 *
 * Exported because every implementation needs the same answer and none of them
 * should be deciding it separately: a key that means one thing in a directory
 * tree and another in a flat map is how two adapters come to disagree, which
 * is the failure this whole seam exists to make unreachable.
 */
export function keySegments(key: string): string[] {
	const segments = key.split('/');
	if (
		segments.length === 0 ||
		segments.some(
			(segment) => segment === '' || segment === '.' || segment === '..',
		)
	) {
		throw new Error(
			`A blob key must be non-empty slash-separated segments: ${key}`,
		);
	}
	return segments;
}
