import { foldMicLevel } from '$lib/recording-pill/level';

/**
 * Reactive mic level for the web pill. On desktop the level travels over a Tauri
 * event to the overlay webview, which smooths it there; on web the pill is an
 * in-page component, so the smoothing lives here and the host reads `level`
 * reactively. Fed by the browser recording mic-level seam.
 */
function createWebPillLevel() {
	let level = $state(0);

	return {
		/** Live, smoothed mic loudness, 0 (silent) to 1 (loud). */
		get level(): number {
			return level;
		},

		/** Fold a raw RMS sample into the smoothed level. */
		report(raw: number): void {
			level = foldMicLevel(level, raw);
		},
	};
}

export const webPillLevel = createWebPillLevel();
