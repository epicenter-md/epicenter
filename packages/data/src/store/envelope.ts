/**
 * The multiplexed payload: one database's updates for many Yjs documents,
 * carried as one opaque byte run (ADR-0248).
 *
 * A database is many independent documents now: the application document that
 * holds every scalar row, and one rich document per row at its derived
 * address. They all synchronize through ONE store connection and one
 * append-only authority log, and the authority never reads bytes, so the
 * document addressing cannot live in a frame or a column it would have to
 * understand. It lives here instead: every pushed submission, every log
 * entry, and every snapshot is an envelope, encoded and decoded entirely on
 * the client side. The frames, the authority, and the hub carry it unread,
 * which is what keeps chunking safe and end-to-end encryption possible.
 *
 * A section names its document with the store's own vocabulary: the reserved
 * `app` name for the application document, or a row's derived address
 * (`{databaseId}/{tableName}/{rowId}`) for a rich document. The envelope does
 * not interpret either; a name is bytes to it.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

export const EnvelopeError = defineErrors({
	Malformed: ({ reason }: { reason: string }) => ({
		message: `This is not an envelope: ${reason}`,
		reason,
	}),
});
export type EnvelopeError = InferErrors<typeof EnvelopeError>;

/** One document's bytes inside an envelope: an update, or a whole state. */
export type EnvelopeSection = { document: string; bytes: Uint8Array };

/**
 * The first byte of every envelope.
 *
 * Not a compatibility sniff: there is exactly one payload format, and bytes
 * that do not start with it are refused whole. It exists so that a stray
 * pre-envelope log entry fails loudly as `Malformed` instead of being decoded
 * as a section count and silently mis-sliced.
 */
const ENVELOPE_MARK = 0xea;

/**
 * `[mark u8][count u32][per section: addressLen u32, address utf8,
 * bytesLen u32, bytes]`, all lengths big-endian to match the frame encoding.
 */
export function encodeEnvelope(
	sections: readonly EnvelopeSection[],
): Uint8Array {
	const encoder = new TextEncoder();
	const encoded = sections.map((section) => ({
		address: encoder.encode(section.document),
		bytes: section.bytes,
	}));
	let total = 5;
	for (const section of encoded) {
		total += 8 + section.address.length + section.bytes.length;
	}
	const buffer = new Uint8Array(total);
	const view = new DataView(buffer.buffer);
	view.setUint8(0, ENVELOPE_MARK);
	view.setUint32(1, encoded.length);
	let at = 5;
	for (const section of encoded) {
		view.setUint32(at, section.address.length);
		buffer.set(section.address, at + 4);
		at += 4 + section.address.length;
		view.setUint32(at, section.bytes.length);
		buffer.set(section.bytes, at + 4);
		at += 4 + section.bytes.length;
	}
	return buffer;
}

export function decodeEnvelope(
	input: Uint8Array,
): Result<EnvelopeSection[], EnvelopeError> {
	if (input.length < 5) {
		return EnvelopeError.Malformed({ reason: `${input.length} bytes` });
	}
	const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
	if (view.getUint8(0) !== ENVELOPE_MARK) {
		return EnvelopeError.Malformed({ reason: 'missing mark' });
	}
	const count = view.getUint32(1);
	const decoder = new TextDecoder();
	const sections: EnvelopeSection[] = [];
	let at = 5;
	for (let index = 0; index < count; index += 1) {
		if (at + 4 > input.length) {
			return EnvelopeError.Malformed({ reason: 'truncated address length' });
		}
		const addressLength = view.getUint32(at);
		at += 4;
		if (at + addressLength + 4 > input.length) {
			return EnvelopeError.Malformed({ reason: 'truncated address' });
		}
		const document = decoder.decode(input.subarray(at, at + addressLength));
		at += addressLength;
		const bytesLength = view.getUint32(at);
		at += 4;
		if (at + bytesLength > input.length) {
			return EnvelopeError.Malformed({ reason: 'truncated section bytes' });
		}
		// Copied rather than viewed, so a buffered section does not pin the whole
		// received message alive.
		sections.push({ document, bytes: input.slice(at, at + bytesLength) });
		at += bytesLength;
	}
	if (at !== input.length) {
		return EnvelopeError.Malformed({
			reason: `${input.length - at} trailing bytes`,
		});
	}
	return Ok(sections);
}
