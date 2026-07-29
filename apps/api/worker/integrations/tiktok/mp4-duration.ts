/**
 * Read a video's duration from its MP4 container, server-side.
 *
 * TikTok enforces a per-account `max_video_post_duration_sec`, and the content
 * sharing guidelines require the publishing surface to stop an over-length post
 * rather than let it fail downstream. A browser can read duration by decoding
 * the file, but a browser-reported number is a CLAIM: the same request can be
 * replayed with a shorter duration in the form. So the Worker reads it from the
 * bytes it is actually going to upload.
 *
 * Workers have no media decoder, but they do not need one. Duration lives in
 * the `mvhd` (movie header) box as a plain integer pair, and the whole file is
 * already in memory for the single-chunk upload, so a small structural walk of
 * the ISO-BMFF box tree is exact for MP4 and needs no dependency.
 *
 * THE BOUNDARY, stated plainly: this reads MP4/ISO-BMFF only, which is the one
 * container this integration accepts (`video/mp4`). For anything it cannot parse
 * it returns
 * `null`, meaning UNKNOWN, never zero and never "fine". Callers must treat
 * `null` as "cannot enforce here" and let TikTok be the backstop, rather than
 * silently admitting the file as valid.
 */

/**
 * ISO-BMFF box header: a 32-bit size then a 4-char type. `size === 1` means the
 * real size is a 64-bit value directly after the type; `size === 0` means the
 * box runs to the end of the file.
 */
const HEADER_BYTES = 8;

/** Box types that contain other boxes and therefore must be descended into. */
const CONTAINER_TYPES = new Set(['moov', 'trak', 'mdia']);

function readType(bytes: Uint8Array, offset: number): string {
	return String.fromCharCode(
		bytes[offset] ?? 0,
		bytes[offset + 1] ?? 0,
		bytes[offset + 2] ?? 0,
		bytes[offset + 3] ?? 0,
	);
}

/**
 * Duration in seconds, or `null` when it cannot be determined.
 *
 * Returns `null` rather than throwing: an unreadable container is an ordinary
 * outcome here (a creator may hand us a MOV or a WebM), not an error the
 * publishing path should fail on by itself.
 */
export function readMp4DurationSec(bytes: Uint8Array): number | null {
	if (bytes.byteLength < HEADER_BYTES) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	/** Walk the boxes in [start, end), descending into containers. */
	function walk(start: number, end: number): number | null {
		let offset = start;
		// A box must at least carry its own header, so stop when less remains.
		while (offset + HEADER_BYTES <= end) {
			const declaredSize = view.getUint32(offset);
			const type = readType(bytes, offset + 4);
			let headerSize = HEADER_BYTES;
			let size = declaredSize;

			if (declaredSize === 1) {
				// 64-bit size follows the type. Sizes beyond Number.MAX_SAFE_INTEGER
				// cannot describe a real upload here, so bail rather than truncate.
				if (offset + 16 > end) return null;
				const large = view.getBigUint64(offset + 8);
				if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
				size = Number(large);
				headerSize = 16;
			} else if (declaredSize === 0) {
				// Runs to the end of the enclosing range.
				size = end - offset;
			}

			// A size smaller than its own header, or one that overruns the parent,
			// means the file is malformed or truncated. Refuse to guess.
			if (size < headerSize || offset + size > end) return null;

			if (type === 'mvhd') {
				return readMvhd(view, offset + headerSize, offset + size);
			}
			if (CONTAINER_TYPES.has(type)) {
				const found = walk(offset + headerSize, offset + size);
				if (found !== null) return found;
			}
			offset += size;
		}
		return null;
	}

	return walk(0, bytes.byteLength);
}

/**
 * `mvhd` payload. Version 0 uses 32-bit times, version 1 uses 64-bit, and the
 * layout is otherwise identical: version+flags, created, modified, timescale,
 * duration.
 *
 * A `duration` of all-ones is ISO-BMFF's "unknown" sentinel, and a zero
 * timescale would make the division meaningless; both answer `null` rather than
 * a fabricated number.
 */
function readMvhd(view: DataView, start: number, end: number): number | null {
	if (start + 4 > end) return null;
	const version = view.getUint8(start);

	if (version === 0) {
		if (start + 20 > end) return null;
		const timescale = view.getUint32(start + 12);
		const duration = view.getUint32(start + 16);
		if (timescale === 0 || duration === 0xff_ff_ff_ff) return null;
		return duration / timescale;
	}
	if (version === 1) {
		if (start + 32 > end) return null;
		const timescale = view.getUint32(start + 20);
		const duration = view.getBigUint64(start + 24);
		if (timescale === 0 || duration === 0xff_ff_ff_ff_ff_ff_ff_ffn) return null;
		return Number(duration) / timescale;
	}
	return null;
}
