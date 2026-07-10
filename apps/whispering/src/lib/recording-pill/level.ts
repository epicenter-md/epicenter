// Raw RMS for speech is small (~0.05 quiet, ~0.2 loud); this gain on a sqrt
// curve maps that range across the meter without clipping early.
const LEVEL_GAIN = 2.4;
// Exponential smoothing weight on the previous sample, so the bars glide
// instead of jittering between the ~20-30 Hz updates.
const SMOOTHING = 0.6;

/**
 * Fold a raw RMS sample into the smoothed 0..1 mic level the pill meter draws.
 * Shared so the desktop overlay webview and the in-page web pill apply the
 * identical perceptual curve by construction, rather than keeping two copies of
 * the constants in sync by hand (ADR-0039).
 */
export function foldMicLevel(previous: number, rawRms: number): number {
	const normalized = Math.min(1, Math.sqrt(rawRms) * LEVEL_GAIN);
	return previous * SMOOTHING + normalized * (1 - SMOOTHING);
}
