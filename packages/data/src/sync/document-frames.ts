/**
 * The wire, which is three messages and no framing beyond a kind byte.
 *
 * `frames.ts` next door has eight kinds, a thirteen-byte header, a chunk index,
 * a chunk count, and a reassembly collector with a buffered-bytes ceiling and
 * two refusals of its own. None of that is carelessness: it is what a
 * positional log needs, because a submission is a batch of documents that must
 * arrive whole and land at one position. This protocol has no positions and no
 * batches, so it has none of it.
 *
 * ## Why there is no chunking here
 *
 * Because the limit that forced it does not apply to a socket. `frames.ts`
 * chunks at `DO_SQLITE_VALUE_CAP`, 2 MiB, and says why in its own words: that
 * is the STORAGE cap, and "chunking happens at the storage boundary rather than
 * on the wire's terms". The wire's own terms are 32 MiB per received message
 * (raised from 1 MiB on 2025-10-31), and a document that cannot be sent in one
 * message is a document too large to hold in a Durable Object's isolate
 * anyway. Two limits, two numbers, and inheriting one for the other is how a
 * margin gets quoted for years at the wrong value — which is a warning
 * `frames.ts` writes about itself.
 *
 * ## Why these three numbers
 *
 * They are `y-protocols`' own: `messageYjsSyncStep1` is 0, `SyncStep2` is 1,
 * and `Update` is 2. Nothing here reads that library, and matching it anyway
 * costs one comment and means a reader who knows the ecosystem is not learning
 * a private dialect of a protocol they already speak.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

/**
 * What a host hands over: something frames can be written to.
 *
 * Here rather than beside either half, because both halves need it and neither
 * owns it. It lived in `document-session.ts` for an hour, which had the hub
 * importing a type from the client and implying a dependency that does not
 * exist. A host makes the socket (ADR-0222); this is the whole of what the
 * library assumes about one.
 */
export type DocumentSocket = { send(bytes: Uint8Array): void };

export const DocumentFrameError = defineErrors({
	Malformed: ({ reason }: { reason: string }) => ({
		message: `This is not a document frame: ${reason}`,
		reason,
	}),
});
export type DocumentFrameError = InferErrors<typeof DocumentFrameError>;

/**
 * Sync step 1: what the sender holds, as a state vector.
 *
 * The question a byte-blind authority could not answer, which is why the
 * transport this replaces had to invent an integer position and everything
 * that hung off it.
 */
export type SyncStep1 = { kind: 'step1'; stateVector: Uint8Array };

/** Sync step 2: everything the receiver lacks, given the vector it sent. */
export type SyncStep2 = { kind: 'step2'; update: Uint8Array };

/**
 * An update, relayed or authored.
 *
 * Identical in handling to a step 2, and separate on the wire for the same
 * reason `y-protocols` keeps them separate: a reader tracing a session should
 * be able to tell a handshake from ongoing traffic without inferring it from
 * position in the stream.
 */
export type DocumentUpdate = { kind: 'update'; update: Uint8Array };

export type DocumentFrame = SyncStep1 | SyncStep2 | DocumentUpdate;

const STEP_1 = 0;
const STEP_2 = 1;
const UPDATE = 2;

const KINDS: Record<DocumentFrame['kind'], number> = {
	step1: STEP_1,
	step2: STEP_2,
	update: UPDATE,
};

export function encodeDocumentFrame(frame: DocumentFrame): Uint8Array {
	const payload = frame.kind === 'step1' ? frame.stateVector : frame.update;
	const bytes = new Uint8Array(1 + payload.length);
	bytes[0] = KINDS[frame.kind];
	bytes.set(payload, 1);
	return bytes;
}

/**
 * Read a frame, or say why it is not one.
 *
 * A `Result` rather than a throw, because this runs on bytes a peer sent and a
 * peer is not a caller: malformed input is an ordinary outcome to report, not
 * a defect to crash on.
 */
export function decodeDocumentFrame(
	input: Uint8Array,
): Result<DocumentFrame, DocumentFrameError> {
	if (input.length === 0) {
		return DocumentFrameError.Malformed({ reason: 'the message is empty' });
	}
	// A copy, so a frame does not alias the buffer a socket handed over and
	// might reuse. `slice` on a Uint8Array copies; `subarray` would not.
	const payload = input.slice(1);
	switch (input[0]) {
		case STEP_1:
			return Ok({ kind: 'step1', stateVector: payload });
		case STEP_2:
			return Ok({ kind: 'step2', update: payload });
		case UPDATE:
			return Ok({ kind: 'update', update: payload });
		default:
			return DocumentFrameError.Malformed({
				reason: `unknown kind ${input[0]}`,
			});
	}
}
