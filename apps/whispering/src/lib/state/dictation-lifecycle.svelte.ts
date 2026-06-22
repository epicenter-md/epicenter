import type { AnyTaggedError } from 'wellcrafted/error';
import type { VadState } from '$lib/constants/audio';
import type { DeliveryReach } from '$lib/operations/delivery';
import type { DictationFailureTier } from '$lib/recording-overlay/events';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

/**
 * The dictation lifecycle owned by the main window. See ADR-0039.
 *
 * Voice-activated capture is *continuous*: an utterance transcribes while the
 * session keeps listening, so a live meter and a pipeline outcome run at once.
 * Manual capture is sequential. Two facts keep both honest:
 *
 * - `capture` is *derived* from the recorder machines: the live session, with no
 *   second copy of "are we recording" to drift.
 * - `outcome` is the most-recent utterance's pipeline result, an ephemeral signal
 *   the pipeline drives. Most-recent-wins: a new utterance overwrites it, and the
 *   OS-notification path reads it and wants each distinct failure exactly once.
 *
 * A failure is transient here, not a held state: the pill glances it (manual),
 * the notification fires it (when unfocused), and the recordings row is the
 * durable record. The pill is not a review surface, so there is no failure latch.
 */
export type DictationCapture =
	| { kind: 'idle' }
	| { kind: 'recording'; trigger: 'manual' }
	| { kind: 'recording'; trigger: 'vad'; vadState: Exclude<VadState, 'IDLE'> };

export type DictationOutcome =
	| { kind: 'none' }
	| { kind: 'transcribing' }
	| { kind: 'polishing' }
	| { kind: 'delivered'; reach: DeliveryReach }
	| ({ kind: 'failed' } & DictationFailure);

export type DictationLifecycle = {
	capture: DictationCapture;
	outcome: DictationOutcome;
};

/** A dictation failure, carrying the live error object for the projection. */
export type DictationFailure = {
	tier: DictationFailureTier;
	error: AnyTaggedError;
};

// How long a clean delivery's checkmark flashes before the outcome retires to
// `none`. Sub-second: the transcribed text landing is the real receipt, so this
// is a glance confirming it, not a notice to read. Only the clean `output` reach
// flashes; a reduced reach persists instead (see `markDelivered`). (A live VAD
// session projects `delivered` to no pip, so this flash only ever shows once
// capture is idle.)
const DELIVERED_FLASH_MS = 900;

function createDictationLifecycle() {
	// The outcome track is the ephemeral signal directly: `none` when no utterance
	// is in flight, otherwise the most-recent utterance's phase. Reset to `none`
	// when a new dictation begins so a stale `failed` never lingers past the next
	// attempt.
	let outcome = $state<DictationOutcome>({ kind: 'none' });
	let deliveredTimer: ReturnType<typeof setTimeout> | undefined;

	function clearDeliveredTimer() {
		clearTimeout(deliveredTimer);
		deliveredTimer = undefined;
	}

	// The live session, read straight off the recorder machines. The pill owner is
	// the most-recent dictation, so a manual recording and a VAD session never
	// both report `recording` (only one recorder is live at a time).
	const capture = $derived.by((): DictationCapture => {
		if (manualRecorder.state === 'RECORDING')
			return { kind: 'recording', trigger: 'manual' };
		if (
			vadRecorder.state === 'LISTENING' ||
			vadRecorder.state === 'SPEECH_DETECTED'
		)
			return { kind: 'recording', trigger: 'vad', vadState: vadRecorder.state };
		return { kind: 'idle' };
	});

	const current = $derived<DictationLifecycle>({ capture, outcome });

	return {
		/** The current lifecycle facts. Read reactively to project them. */
		get current(): DictationLifecycle {
			return current;
		},

		/**
		 * A new dictation is starting: clear any terminal outcome from the last one
		 * so it does not linger into this attempt.
		 */
		reset(): void {
			clearDeliveredTimer();
			outcome = { kind: 'none' };
		},

		/** The recorder stopped (or a VAD utterance ended); now transcribing. */
		markTranscribing(): void {
			clearDeliveredTimer();
			outcome = { kind: 'transcribing' };
		},

		/**
		 * The transcript landed and the always-on Polish pass is now running over it
		 * (ADR 0046). Held until `markDelivered`, with a `ship-raw` control on the
		 * pill to skip it. Only entered when a Polish pass actually runs (a configured
		 * key, Polish on); speed mode goes straight from transcribing to delivered.
		 */
		markPolishing(): void {
			clearDeliveredTimer();
			outcome = { kind: 'polishing' };
		},

		/**
		 * The transcript landed. `reach` is how far it got toward the configured
		 * output: a clean `output`, a `clipboard` fallback, or `history`-only when a
		 * requested channel failed. Every reach is a success (the text is saved), so
		 * none of them is a dictation failure.
		 *
		 * A clean `output` flashes for a beat and retires: the landing text is the
		 * receipt, so the pill is just a glance. A reduced reach (`clipboard` or
		 * `history`) instead persists until the next dictation, like a failure does:
		 * the text did not land where the user asked, so the tag carries information
		 * the text alone does not, and a sub-second flash is too easy to miss. There
		 * is no notification for a reduced reach (ADR-0039): the persistent pill tag
		 * and the recordings row are the surfaces, and the dominant `history` cause
		 * (a revoked Accessibility grant) already raises its own standing notice.
		 */
		markDelivered(reach: DeliveryReach): void {
			clearDeliveredTimer();
			outcome = { kind: 'delivered', reach };
			// Only the clean reach auto-retires; a reduced reach stays put.
			if (reach !== 'output') return;
			deliveredTimer = setTimeout(() => {
				deliveredTimer = undefined;
				// Only retire the flash if a newer outcome has not taken over.
				if (outcome.kind === 'delivered') outcome = { kind: 'none' };
			}, DELIVERED_FLASH_MS);
		},

		/** A dictation failed: hold the failed outcome until the next dictation
		 * resets it. Transient, not a held state: the pill glances it (manual), the
		 * notification path fires it, and the recordings row is the durable record. */
		markFailed(failure: DictationFailure): void {
			clearDeliveredTimer();
			outcome = { kind: 'failed', ...failure };
		},
	};
}

export const dictationLifecycle = createDictationLifecycle();
