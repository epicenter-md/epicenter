import { webPillLevel } from '$lib/recording-pill/web-level.svelte';

/** Feed a raw RMS sample to the in-page recording pill's reactive meter. */
export function reportRecordingMicLevel(level: number): void {
	webPillLevel.report(level);
}
