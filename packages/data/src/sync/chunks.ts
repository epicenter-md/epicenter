/**
 * Splitting one update to fit a Durable Object's value cap, and putting it back.
 *
 * Storage, never the wire. This lived in `frames.ts` beside a positional log's
 * framing, and the two were only ever adjacent: the socket's limit is 32 MiB
 * (raised from 1 MiB on 2025-10-31), a document too big for one message is too
 * big for an isolate anyway, and the wire kinds carry no chunk index at all.
 * What is left is the storage cap, which is a different number for a different
 * reason and belongs beside the thing that stores (ADR-0282).
 *
 * ## The number, and why it is not the enforced one
 *
 * Cloudflare documents 2 MB per SQLite value. Bisected to the byte in a live
 * Durable Object, the engine stores up to 2,199,994 bytes and refuses
 * 2,199,995 with `SQLITE_TOOBIG` (`evidence/workerd/`). So this sits about
 * 102 KB under the wall rather than on it, and that is deliberate: the
 * documented limit is the one Cloudflare is entitled to enforce, and the
 * headroom also absorbs the row's other columns. The reason is "a policy with
 * margin", not "the exact edge". A margin nobody measured is how a limit gets
 * quoted for years at the wrong value.
 */

/** What Cloudflare documents as the per-value cap for a Durable Object. */
export const DO_SQLITE_VALUE_CAP = 2_097_152;

/**
 * How many payload bytes one chunk carries.
 *
 * Equal to the documented cap. Verified at the boundary rather than at a
 * comfortable 3 MB, because a limit tested with a wide margin tells you the
 * margin and not the limit.
 */
export const CHUNK_BYTES = DO_SQLITE_VALUE_CAP;

/**
 * Split one update into chunks that each fit the storage cap.
 *
 * Bounding storage, not bounding a buffer. An earlier design bounded the
 * coalesce buffer by size instead, which fixed nothing: a single paste is
 * 4.77 MB in ONE transaction, so there is no seam for a coalescing bound to
 * cut at, while a week of fully offline field edits coalesces to 99 KB and
 * never approaches the cap at all.
 *
 * An empty update yields one empty chunk rather than none, so that "how many
 * chunks went in" and "how many came out" always agree.
 */
export function intoChunks(
	bytes: Uint8Array,
	limit = CHUNK_BYTES,
): Uint8Array[] {
	if (bytes.length <= limit) return [bytes];
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < bytes.length; at += limit) {
		chunks.push(bytes.subarray(at, Math.min(at + limit, bytes.length)));
	}
	return chunks;
}

/** Concatenate chunks back into the update they were cut from. */
export function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
	if (chunks.length === 1) return chunks[0] as Uint8Array;
	let total = 0;
	for (const chunk of chunks) total += chunk.length;
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	return bytes;
}
