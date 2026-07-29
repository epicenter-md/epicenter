import { expect, test } from 'bun:test';
import { readMp4DurationSec } from './mp4-duration.js';

/** Build one ISO-BMFF box: [size:4][type:4][payload]. */
function box(type: string, payload: Uint8Array): Uint8Array {
	const size = 8 + payload.byteLength;
	const bytes = new Uint8Array(size);
	new DataView(bytes.buffer).setUint32(0, size);
	bytes.set(new TextEncoder().encode(type), 4);
	bytes.set(payload, 8);
	return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	return bytes;
}

/** A version-0 mvhd payload: version+flags, created, modified, timescale, duration. */
function mvhdV0(timescale: number, duration: number): Uint8Array {
	const payload = new Uint8Array(20);
	const view = new DataView(payload.buffer);
	view.setUint8(0, 0);
	view.setUint32(4, 0);
	view.setUint32(8, 0);
	view.setUint32(12, timescale);
	view.setUint32(16, duration);
	return payload;
}

/** A version-1 mvhd payload, which uses 64-bit times. */
function mvhdV1(timescale: number, duration: bigint): Uint8Array {
	const payload = new Uint8Array(32);
	const view = new DataView(payload.buffer);
	view.setUint8(0, 1);
	view.setBigUint64(4, 0n);
	view.setBigUint64(12, 0n);
	view.setUint32(20, timescale);
	view.setBigUint64(24, duration);
	return payload;
}

/** `ftyp` then `moov > mvhd`, the ordinary shape. */
function mp4(mvhdPayload: Uint8Array, leading = 'ftyp'): Uint8Array {
	return concat(
		box(leading, new Uint8Array(8)),
		box('moov', box('mvhd', mvhdPayload)),
	);
}

test('reads duration from a version-0 mvhd', () => {
	// 15000 units at a 1000-unit timescale is 15 seconds.
	expect(readMp4DurationSec(mp4(mvhdV0(1000, 15_000)))).toBeCloseTo(15, 5);
});

test('reads duration from a version-1 (64-bit) mvhd', () => {
	expect(readMp4DurationSec(mp4(mvhdV1(600, 180_000n)))).toBeCloseTo(300, 5);
});

test('finds mvhd when moov comes AFTER the media data', () => {
	// Streaming-optimized files put moov first, but a plain export often puts
	// mdat first and moov at the very end. Both must read.
	const bytes = concat(
		box('ftyp', new Uint8Array(8)),
		box('mdat', new Uint8Array(4096)),
		box('moov', box('mvhd', mvhdV0(30_000, 900_000))),
	);

	expect(readMp4DurationSec(bytes)).toBeCloseTo(30, 5);
});

test('descends through nested containers to reach mvhd', () => {
	const bytes = concat(
		box('ftyp', new Uint8Array(8)),
		box(
			'moov',
			concat(
				box('trak', box('mdia', new Uint8Array(8))),
				box('mvhd', mvhdV0(1000, 5_500)),
			),
		),
	);

	expect(readMp4DurationSec(bytes)).toBeCloseTo(5.5, 5);
});

test('handles a 64-bit box size', () => {
	const inner = box('mvhd', mvhdV0(1000, 2_000));
	// size=1 signals a 64-bit largesize immediately after the type.
	const moov = new Uint8Array(16 + inner.byteLength);
	const view = new DataView(moov.buffer);
	view.setUint32(0, 1);
	moov.set(new TextEncoder().encode('moov'), 4);
	view.setBigUint64(8, BigInt(moov.byteLength));
	moov.set(inner, 16);

	expect(
		readMp4DurationSec(concat(box('ftyp', new Uint8Array(8)), moov)),
	).toBeCloseTo(2, 5);
});

test('a non-MP4 container reads as UNKNOWN, not as zero', () => {
	// The distinction is load-bearing: zero would silently pass a duration gate,
	// while null tells the caller it cannot enforce one here.
	const webmish = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6]);

	expect(readMp4DurationSec(webmish)).toBeNull();
});

test('an MP4 with no mvhd reads as unknown', () => {
	const bytes = concat(
		box('ftyp', new Uint8Array(8)),
		box('moov', box('trak', new Uint8Array(8))),
	);

	expect(readMp4DurationSec(bytes)).toBeNull();
});

test('a truncated or malformed box is refused rather than guessed', () => {
	// Declares a 4 KB box in a 16-byte file.
	const bytes = new Uint8Array(16);
	new DataView(bytes.buffer).setUint32(0, 4096);
	bytes.set(new TextEncoder().encode('moov'), 4);

	expect(readMp4DurationSec(bytes)).toBeNull();
});

test('a box smaller than its own header is refused', () => {
	const bytes = new Uint8Array(16);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, 3);
	bytes.set(new TextEncoder().encode('moov'), 4);

	expect(readMp4DurationSec(bytes)).toBeNull();
});

test("mvhd's all-ones unknown-duration sentinel reads as unknown", () => {
	expect(readMp4DurationSec(mp4(mvhdV0(1000, 0xff_ff_ff_ff)))).toBeNull();
});

test('a zero timescale reads as unknown instead of dividing by zero', () => {
	expect(readMp4DurationSec(mp4(mvhdV0(0, 1000)))).toBeNull();
});

test('an empty or tiny buffer reads as unknown', () => {
	expect(readMp4DurationSec(new Uint8Array(0))).toBeNull();
	expect(readMp4DurationSec(new Uint8Array(4))).toBeNull();
});

test('a long video reports its real length, so a ceiling can refuse it', () => {
	// 11 minutes against a 10-minute account ceiling.
	const eleven = readMp4DurationSec(mp4(mvhdV0(1000, 660_000)));

	expect(eleven).toBeCloseTo(660, 5);
	expect(eleven as number).toBeGreaterThan(600);
});
