/**
 * When a chain of updates is worth collapsing, and the floor under that.
 *
 * One rule, two media. A document's durable record is a folded state followed
 * by the updates applied since (ADR-0280 on the client, ADR-0277 on the
 * authority): appending is O(update), reading is O(chain), and folding trades
 * one O(document) write for a shorter chain. Both sides face that trade, both
 * sides answer it the same way, and the answer lives here so they cannot come
 * to differ about it in a way nothing would detect.
 *
 * The media stay apart. The authority stores chunked rows in a Durable
 * Object's SQLite; a browser stores records in one IndexedDB object store.
 * What is shared is the arithmetic, not the storage.
 *
 * ## Why bytes rather than a count
 *
 * `y-indexeddb` folds at `PREFERRED_TRIM_SIZE = 500` updates, and a count is
 * wrong in both directions: 500 keystrokes against a 10 MB document rewrites
 * 10 MB to reclaim a few kilobytes, and 50 updates carrying a pasted megabyte
 * each never trigger. What a chain costs to load and to hold tracks its bytes,
 * so bytes are what decide.
 */

/**
 * Below this the whole tail is trivial and folding it buys nothing.
 *
 * "The tail outgrew the state" is scale-free, so on a small document it is
 * true on the very next update and a live run would fold on nearly every
 * message. The floor is the honest asterisk on "no number to pick".
 */
export const FOLD_FLOOR_BYTES = 64 * 1024;

/**
 * Whether the tail has outgrown the state, and is worth folding at all.
 *
 * A pure function of two totals, so a caller may answer it from whatever it
 * already knows: the authority sums stored rows, and a browser keeps a running
 * count rather than reading the chain back to measure it, because reading the
 * chain is the cost the fold exists to avoid.
 *
 * Safe to ignore. `fold` is only ever wasteful when this is false, never
 * wrong.
 */
export function shouldFold(
	stateBytes: number,
	tailBytes: number,
	floorBytes: number = FOLD_FLOOR_BYTES,
): boolean {
	return tailBytes >= floorBytes && tailBytes > stateBytes;
}
