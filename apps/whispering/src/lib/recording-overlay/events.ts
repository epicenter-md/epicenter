/**
 * Tauri event contract for the recording overlay window. The main window pushes
 * the shared pill status into the secondary webview; the overlay sends pill
 * actions, readiness, and reveal requests back.
 *
 * Event names are durable wire values shared with the Rust recorder where
 * noted. Presentation vocabulary lives in `recording-pill/model.ts`; this
 * module only binds those payloads to transport channels.
 */
import { defineWindowEvent, defineWindowSignal } from '#platform/window-events';
import type {
	RecordingPillAction,
	RecordingPillStatus,
} from '$lib/recording-pill/model';

/** Stable Tauri label for the secondary recording pill webview. */
export const RECORDING_OVERLAY_WINDOW_LABEL = 'recording-overlay';

/** main -> overlay: what the shared recording pill should display. */
export const recordingOverlayStatus = defineWindowEvent<RecordingPillStatus>(
	'recording-overlay:status',
);

/** overlay -> main: the user invoked a recording pill control. */
export const recordingOverlayAction = defineWindowEvent<RecordingPillAction>(
	'recording-overlay:action',
);

/** overlay -> main: reveal the main Whispering window. */
export const revealMainWindow = defineWindowSignal('main-window:reveal');

/**
 * overlay -> main: the overlay mounted and its listener is live, so the main
 * window should re-send the latest status.
 */
export const recordingOverlayReady = defineWindowSignal(
	'recording-overlay:ready',
);

/**
 * Live mic level (main -> overlay), a raw RMS amplitude. The bare `mic-level`
 * name is shared with the Rust recorder's `MIC_LEVEL_EVENT`.
 */
export const recordingOverlayMicLevel = defineWindowEvent<number>('mic-level');
