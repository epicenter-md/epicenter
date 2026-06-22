import type { VadState } from '$lib/constants/audio';
import type { DeliveryReach } from '$lib/operations/delivery';
import { defineWindowEvent, defineWindowSignal } from '$lib/window-events';

/**
 * Event contract for the recording overlay window.
 *
 * The overlay lives in its own webview and therefore cannot read the recorder
 * state modules directly. The main window pushes the current status to the
 * overlay, and the overlay pushes user actions back. The channels below carry
 * that traffic; each binds its name to its payload so emitter and listener stay
 * in sync (see `defineWindowEvent`).
 *
 * This module imports no Tauri runtime APIs beyond the typed-channel helper, so
 * it stays loadable on web (where the overlay never exists) and from the overlay
 * page itself.
 */

/**
 * How severe a dictation failure is, which decides how loudly it surfaces.
 * Severity is a function of where the dictation failed, not the error's name. A
 * failure means no usable text was produced. A transcript that was produced but
 * not delivered to the configured output is not a failure: it is a reduced
 * delivery reach (see `DeliveryReach` in operations/delivery), so it is absent
 * here.
 *
 * - `silent-loss`: the recording never started (no mic, denied permission), so
 *   there is no artifact to recover. Loudest, because the user spoke into
 *   nothing.
 * - `transcription`: the recording was captured (a recordings row exists) but
 *   transcription failed. The audio is safe and the failure is retryable.
 */
export type DictationFailureTier = 'silent-loss' | 'transcription';

/**
 * The terse, glanceable name of each failure tier, and the single source of
 * failure copy: the pill renders it as the failed chip's label, and the OS
 * notification uses it as the notification title (see attach-dictation-exceptions).
 * It is deliberately a short closed token, never a raw error message, so it fits
 * the fixed-width pill without truncation. The full error detail is never here; it
 * lives on the recordings row and in the notification body.
 */
export const FAILURE_LABEL = {
	'silent-loss': 'Recording failed',
	transcription: 'Transcription failed',
} as const satisfies Record<DictationFailureTier, string>;

/**
 * The secondary pip riding alongside a live VAD meter, when there is one. In a
 * continuous session the meter (listening) and the previous utterance's work run
 * at once, so the work shows as a small spinner on the meter rather than
 * replacing it; an absent pip is the resting state. There is deliberately no
 * `delivered` pip (the landing text is the receipt) and no `failed` pip: a VAD
 * failure is not shown on the pill, it goes to the OS notification and the
 * recordings row (ADR-0039).
 */
export type VadOutcomePip = 'transcribing';

/**
 * What the pill should display, the serializable projection of the main
 * window's dictation lifecycle. Only the non-idle phases are representable: an
 * idle dictation hides the pill rather than emitting a status, so there is no
 * `idle` variant to render. The `failed` variant carries only the failure `tier`
 * (never the live error object) so it can cross the Tauri IPC boundary to the
 * overlay webview; the pill maps it to a terse label via `FAILURE_LABEL`, and the
 * full error detail lives on the recordings row and in the OS notification.
 *
 * The VAD `recording` variant may also carry `pip`: the live meter is the
 * primary content, and a concurrent utterance's work rides beside it. The pip is
 * absent (omitted) when nothing rides alongside.
 *
 * The `polishing` phase is the always-on AI cleanup running between transcribe
 * and delivery (ADR 0046): the pill holds the same spot, showing a "Polishing…"
 * HUD with a single `ship-raw` control to skip the pass and take the raw
 * transcript now. Unlike the other post-capture phases it carries an action.
 */
export type RecordingOverlayStatus =
	| { phase: 'recording'; trigger: 'manual' }
	| {
			phase: 'recording';
			trigger: 'vad';
			vadState: Exclude<VadState, 'IDLE'>;
			pip?: VadOutcomePip;
	  }
	| { phase: 'transcribing' }
	| { phase: 'polishing' }
	| { phase: 'delivered'; reach: DeliveryReach }
	| { phase: 'failed'; tier: DictationFailureTier };

/**
 * The control the user invoked from the overlay. `stop`/`cancel` act on a live
 * capture; `ship-raw` cancels the in-flight Polish pass and delivers the raw
 * transcript immediately (ADR 0046). There is no retry here: a failed dictation
 * is retried from its recordings row, not the pill (ADR-0039).
 */
export type RecordingOverlayAction = 'stop' | 'cancel' | 'ship-raw';

/** main -> overlay: what to display, or that the overlay is shown. */
export const recordingOverlayStatus = defineWindowEvent<RecordingOverlayStatus>(
	'recording-overlay:status',
);

/** overlay -> main: the user clicked stop or cancel. */
export const recordingOverlayAction = defineWindowEvent<RecordingOverlayAction>(
	'recording-overlay:action',
);

/**
 * overlay -> main: the overlay mounted and its listener is live, so the main
 * window should re-send the latest status. Without this handshake the first
 * status can be emitted before the overlay's listener is attached and get lost.
 */
export const recordingOverlayReady = defineWindowSignal(
	'recording-overlay:ready',
);

/**
 * Live mic level (main -> overlay), a raw RMS amplitude (~0 silent, ~0.3 loud
 * speech). The overlay applies the perceptual gain and smoothing so both
 * producers, VAD frames in JS and the CPAL worker in Rust, can stay dumb and
 * just report RMS. The name stays the bare string `mic-level` because the Rust
 * recorder emits the same channel (see recorder.rs `MIC_LEVEL_EVENT`).
 */
export const recordingOverlayMicLevel = defineWindowEvent<number>('mic-level');
