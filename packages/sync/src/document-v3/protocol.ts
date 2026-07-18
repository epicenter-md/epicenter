export const DOCUMENT_SUBPROTOCOL = 'epicenter-document-v3';

export const DOCUMENT_CLOSE_CODE = {
	'too-large': 1009,
} as const;

export type DocumentCloseReason = keyof typeof DOCUMENT_CLOSE_CODE;
export type DocumentStopReason = 'too-large';
export type DocumentCloseCode =
	(typeof DOCUMENT_CLOSE_CODE)[DocumentStopReason];

const HEADER_BYTES = 1;
const ENCODED_FRAME_BYTES = 1_048_576;

export const DOCUMENT_FRAME_LIMITS = {
	headerBytes: HEADER_BYTES,
	encodedFrameBytes: ENCODED_FRAME_BYTES,
	payloadBytes: ENCODED_FRAME_BYTES - HEADER_BYTES,
} as const;

/** One data message on a WebSocket already scoped to one row document. */
export type DocumentFrame =
	| { kind: 'sync-request'; stateVector: Uint8Array }
	| { kind: 'sync-response'; update: Uint8Array }
	| { kind: 'update'; update: Uint8Array };

const FRAME_TYPE = {
	'sync-request': 0,
	'sync-response': 1,
	update: 2,
} as const;

/**
 * Encode one document-local WebSocket message.
 *
 * The selected WebSocket subprotocol owns the protocol major and WebSocket
 * preserves message boundaries, so the envelope is only `[kind:u8][payload]`.
 */
export function encodeDocumentFrame(
	frame: DocumentFrame,
): Uint8Array<ArrayBuffer> {
	assertFrame(frame);
	const payload =
		frame.kind === 'sync-request' ? frame.stateVector : frame.update;
	const encoded = new Uint8Array(HEADER_BYTES + payload.byteLength);
	encoded[0] = FRAME_TYPE[frame.kind];
	encoded.set(payload, HEADER_BYTES);
	return encoded;
}

/** Decode and validate one complete document-local WebSocket message. */
export function decodeDocumentFrame(encoded: Uint8Array): DocumentFrame {
	if (
		!(encoded instanceof Uint8Array) ||
		encoded.byteLength <= HEADER_BYTES ||
		encoded.byteLength > DOCUMENT_FRAME_LIMITS.encodedFrameBytes
	) {
		throw new TypeError('Invalid document frame');
	}

	const payload = encoded.slice(HEADER_BYTES);
	switch (encoded[0]) {
		case FRAME_TYPE['sync-request']:
			return { kind: 'sync-request', stateVector: payload };
		case FRAME_TYPE['sync-response']:
			return { kind: 'sync-response', update: payload };
		case FRAME_TYPE.update:
			return { kind: 'update', update: payload };
		default:
			throw new TypeError('Unknown document frame kind');
	}
}

function assertFrame(frame: DocumentFrame): void {
	if (!isRecord(frame) || typeof frame.kind !== 'string') {
		throw new TypeError('Invalid document frame');
	}
	switch (frame.kind) {
		case 'sync-request':
			assertExactKeys(frame, ['kind', 'stateVector']);
			assertPayload(frame.stateVector);
			return;
		case 'sync-response':
		case 'update':
			assertExactKeys(frame, ['kind', 'update']);
			assertPayload(frame.update);
			return;
		default:
			throw new TypeError('Unknown document frame kind');
	}
}

function assertPayload(value: unknown): asserts value is Uint8Array {
	if (
		!(value instanceof Uint8Array) ||
		value.byteLength === 0 ||
		value.byteLength > DOCUMENT_FRAME_LIMITS.payloadBytes
	) {
		throw new TypeError('Invalid document frame payload');
	}
}

function assertExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): void {
	const keys = Object.keys(value);
	if (
		keys.length !== expected.length ||
		expected.some((key) => !Object.hasOwn(value, key))
	) {
		throw new TypeError('Document frame has unexpected fields');
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
