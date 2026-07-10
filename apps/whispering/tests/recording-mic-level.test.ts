/**
 * Recording Mic Level Tests
 *
 * Locks the perceptual gain and smoothing shared by both pill mounts after raw
 * mic-level delivery crosses its platform seam.
 *
 * Key behaviors:
 * - Silence remains silent
 * - Loud input clamps before smoothing
 * - Prior level decays smoothly when input stops
 */
import { expect, test } from 'bun:test';
import { foldMicLevel } from '../src/lib/recording-pill/level';

test('silence remains silent', () => {
	expect(foldMicLevel(0, 0)).toBe(0);
});

test('loud input clamps before smoothing', () => {
	expect(foldMicLevel(0, 1)).toBeCloseTo(0.4);
});

test('prior level decays smoothly when input stops', () => {
	expect(foldMicLevel(0.5, 0)).toBeCloseTo(0.3);
});
