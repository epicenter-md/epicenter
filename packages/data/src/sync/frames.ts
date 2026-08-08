/**
 * The wire, which is framing and nothing else.
 *
 * Every frame is binary. Nothing here knows what an update means, what a row
 * is, or what Yjs is; a payload is a run of bytes with a position in a
 * submission or in the authority's log. That is deliberate and it is the whole
 * reason chunking is safe to do at this layer: splitting bytes cannot be wrong
 * about semantics it does not have.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

/**
 * The largest value Durable Object SQLite will store in one column.
 *
 * The wall that makes chunking necessary, and it has nothing to do with
 * hydration cost or with Yjs. A WebSocket accepts 32 MiB, so an update between
 * these two numbers is one `workerd` swallows on the way to storage.
 */
export const DO_SQLITE_VALUE_CAP = 2_097_152;

/**
 * How many payload bytes one chunk carries.
 *
 * Equal to the storage cap, so a chunk is stored as one value with nothing
 * spare. Verified at the exact boundary rather than at a comfortable margin
 * (`evidence/workerd/`), because a limit tested at 3 MB tells you nothing about
 * where it actually is.
 */
export const CHUNK_BYTES = DO_SQLITE_VALUE_CAP;

export const FrameError = defineErrors({
	Malformed: ({ reason }: { reason: string }) => ({
		message: `This is not a frame: ${reason}`,
		reason,
	}),
});
export type FrameError = InferErrors<typeof FrameError>;

/** A client offering bytes it authored. The authority assigns the position. */
export type PushFrame = {
	kind: 'push';
	/** Client-scoped and monotonic, so an ack can name what it answers. */
	submission: number;
	chunk: number;
	chunks: number;
	bytes: Uint8Array;
};

/**
 * The authority took responsibility, at this position.
 *
 * The mechanism that makes a refusal visible. `workerd` swallows a throw in
 * `webSocketMessage` without closing the socket, so a client with no ack cannot
 * distinguish "stored" from "vanished", and a client that cannot distinguish
 * them will drop the work either way.
 */
export type AckFrame = { kind: 'ack'; submission: number; seq: number };

/** The authority refused, and said so rather than dropping it in silence. */
export type RefuseFrame = { kind: 'refuse'; submission: number; reason: string };

/** One entry of the authority's log, on its way to a replica. */
export type EntryFrame = {
	kind: 'entry';
	seq: number;
	chunk: number;
	chunks: number;
	bytes: Uint8Array;
};

export type Frame = PushFrame | AckFrame | RefuseFrame | EntryFrame;

const PUSH = 1;
const ACK = 2;
const REFUSE = 3;
const ENTRY = 4;

/** `u8 kind` plus three `u32` fields, ahead of the payload. */
const DATA_HEADER_BYTES = 13;

export function encodeFrame(frame: Frame): Uint8Array {
	switch (frame.kind) {
		case 'push':
			return encodeData(PUSH, frame.submission, frame.chunk, frame.chunks, frame.bytes);
		case 'entry':
			return encodeData(ENTRY, frame.seq, frame.chunk, frame.chunks, frame.bytes);
		case 'ack': {
			const buffer = new Uint8Array(9);
			const view = new DataView(buffer.buffer);
			view.setUint8(0, ACK);
			view.setUint32(1, frame.submission);
			view.setUint32(5, frame.seq);
			return buffer;
		}
		case 'refuse': {
			const reason = new TextEncoder().encode(frame.reason);
			const buffer = new Uint8Array(5 + reason.length);
			const view = new DataView(buffer.buffer);
			view.setUint8(0, REFUSE);
			view.setUint32(1, frame.submission);
			buffer.set(reason, 5);
			return buffer;
		}
	}
}

function encodeData(
	kind: number,
	position: number,
	chunk: number,
	chunks: number,
	bytes: Uint8Array,
): Uint8Array {
	const buffer = new Uint8Array(DATA_HEADER_BYTES + bytes.length);
	const view = new DataView(buffer.buffer);
	view.setUint8(0, kind);
	view.setUint32(1, position);
	view.setUint32(5, chunk);
	view.setUint32(9, chunks);
	buffer.set(bytes, DATA_HEADER_BYTES);
	return buffer;
}

export function decodeFrame(input: Uint8Array): Result<Frame, FrameError> {
	if (input.length === 0) return FrameError.Malformed({ reason: 'empty' });
	const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
	const kind = view.getUint8(0);

	if (kind === ACK || kind === REFUSE) {
		if (input.length < 5) {
			return FrameError.Malformed({ reason: `control frame is ${input.length} bytes` });
		}
		const submission = view.getUint32(1);
		if (kind === REFUSE) {
			return Ok({
				kind: 'refuse',
				submission,
				reason: new TextDecoder().decode(input.subarray(5)),
			});
		}
		if (input.length < 9) {
			return FrameError.Malformed({ reason: `ack is ${input.length} bytes` });
		}
		return Ok({ kind: 'ack', submission, seq: view.getUint32(5) });
	}

	if (kind !== PUSH && kind !== ENTRY) {
		return FrameError.Malformed({ reason: `unknown kind ${kind}` });
	}
	if (input.length < DATA_HEADER_BYTES) {
		return FrameError.Malformed({ reason: `data frame is ${input.length} bytes` });
	}
	const position = view.getUint32(1);
	const chunk = view.getUint32(5);
	const chunks = view.getUint32(9);
	if (chunks === 0 || chunk >= chunks) {
		return FrameError.Malformed({ reason: `chunk ${chunk} of ${chunks}` });
	}
	// Copied rather than viewed. A `subarray` keeps the whole received message
	// alive for as long as any chunk of it is buffered, which on the authority
	// is until the last chunk arrives.
	const bytes = input.slice(DATA_HEADER_BYTES);
	return Ok(
		kind === PUSH
			? { kind: 'push', submission: position, chunk, chunks, bytes }
			: { kind: 'entry', seq: position, chunk, chunks, bytes },
	);
}

/**
 * Split one update into chunks that each fit the storage cap.
 *
 * Framing, not bounding. An earlier design bounded the coalesce buffer by size
 * instead, which fixed nothing: a single paste is 4.77 MB in ONE transaction,
 * so there is no seam for a coalescing bound to cut at, while a week of fully
 * offline field edits coalesces to 99 KB and never approaches the cap at all.
 *
 * An empty update yields one empty chunk rather than none, so that "how many
 * chunks did you send" and "how many did I receive" always agree.
 */
export function intoChunks(bytes: Uint8Array, limit = CHUNK_BYTES): Uint8Array[] {
	if (bytes.length <= limit) return [bytes];
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < bytes.length; at += limit) {
		chunks.push(bytes.subarray(at, Math.min(at + limit, bytes.length)));
	}
	return chunks;
}

/** Concatenate chunks back into the update they were cut from. */
export function reassemble(chunks: readonly Uint8Array[]): Uint8Array {
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

/**
 * Collect the chunks of one submission until it is whole.
 *
 * In memory rather than in storage, and that is the ack doing its job: a
 * partial submission that is lost to eviction is one the client never hears an
 * ack for, so the client still owes it and re-offers it. Storing partials
 * durably would mean the log could hold an entry that is real but truncated,
 * and a truncated entry is the poison pill this design spends a Yjs call to
 * avoid.
 */
export type ChunkCollector = {
	/** Add one chunk. Returns the whole update once the last one lands. */
	accept(frame: PushFrame | EntryFrame): Result<Uint8Array | undefined, FrameError>;
	/** How many bytes are held for submissions that are still incomplete. */
	bufferedBytes(): number;
	forget(position: number): void;
};

export function createChunkCollector({
	limitBytes,
}: {
	/** Refuse to buffer more than this across all in-flight submissions. */
	limitBytes: number;
}): ChunkCollector {
	const partials = new Map<
		number,
		{ chunks: Uint8Array[]; held: number; filled: number }
	>();
	let buffered = 0;

	return {
		accept(frame) {
			const position = frame.kind === 'push' ? frame.submission : frame.seq;
			if (frame.chunks === 1) return Ok(frame.bytes);

			const partial = partials.get(position) ?? {
				chunks: new Array<Uint8Array>(frame.chunks),
				held: 0,
				filled: 0,
			};
			if (partial.chunks.length !== frame.chunks) {
				partials.delete(position);
				buffered -= partial.held;
				return FrameError.Malformed({
					reason: `submission ${position} changed from ${partial.chunks.length} chunks to ${frame.chunks}`,
				});
			}
			if (buffered + frame.bytes.length > limitBytes) {
				partials.delete(position);
				buffered -= partial.held;
				return FrameError.Malformed({
					reason: `buffering ${buffered + frame.bytes.length} bytes exceeds ${limitBytes}`,
				});
			}
			// Counted rather than probed with `every`, which SKIPS the holes of a
			// sparse array and so reports a submission complete on its first chunk.
			// A re-sent chunk replaces its slot without counting twice.
			const previous = partial.chunks[frame.chunk];
			if (previous === undefined) {
				partial.filled += 1;
			} else {
				partial.held -= previous.length;
				buffered -= previous.length;
			}
			partial.chunks[frame.chunk] = frame.bytes;
			partial.held += frame.bytes.length;
			buffered += frame.bytes.length;
			partials.set(position, partial);

			if (partial.filled < frame.chunks) return Ok(undefined);
			partials.delete(position);
			buffered -= partial.held;
			return Ok(reassemble(partial.chunks));
		},
		bufferedBytes: () => buffered,
		forget(position) {
			const partial = partials.get(position);
			if (partial === undefined) return;
			buffered -= partial.held;
			partials.delete(position);
		},
	};
}
