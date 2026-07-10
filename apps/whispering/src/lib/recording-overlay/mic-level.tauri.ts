import {
	RECORDING_OVERLAY_WINDOW_LABEL,
	recordingOverlayMicLevel,
} from '$lib/recording-overlay/events';

/**
 * Forward a raw RMS sample to the overlay webview. A sample can race ahead of
 * window creation, but a missed meter frame is invisible and must never disrupt
 * recording.
 */
export function reportRecordingMicLevel(level: number): void {
	void recordingOverlayMicLevel
		.emitTo(RECORDING_OVERLAY_WINDOW_LABEL, level)
		.catch(() => {});
}
