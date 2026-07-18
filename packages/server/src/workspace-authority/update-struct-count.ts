import { UpdateDecoderV2 } from '@y/y';
import { LazyStructReader } from '@y/y/src/utils/updates.js';
import * as decoding from 'lib0/decoding';

/**
 * True when the candidate encodes more than `limit` structs.
 *
 * Counted with the lazy struct reader so a hostile struct-dense candidate is
 * refused with O(1) retained memory and CPU proportional to the limit,
 * instead of first materializing millions of structs through decode or apply.
 * Throws on a malformed update, like every other decoder entry point.
 *
 * The reader import rides the repository's pinned `@y/y` patch; the
 * conformance test against `decodeUpdateV2` guards this seam across
 * dependency upgrades.
 */
export function updateStructCountExceeds(
	update: Uint8Array,
	limit: number,
): boolean {
	const reader = new LazyStructReader(
		new UpdateDecoderV2(decoding.createDecoder(update)),
		false,
	);
	let count = 0;
	for (let struct = reader.curr; struct !== null; struct = reader.next()) {
		count += 1;
		if (count > limit) return true;
	}
	return false;
}
