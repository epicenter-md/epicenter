import type { DeliveryReach } from '$lib/operations/delivery';
import type { DictationFailureTier } from '$lib/state/dictation-lifecycle.svelte';

/**
 * What the shared recording pill should display. Only non-idle phases are
 * representable: an idle dictation hides the pill rather than producing a
 * status. The model is platform-free; Tauri serializes it over overlay IPC and
 * the browser host consumes it directly.
 */
export type RecordingPillStatus =
	| { phase: 'recording'; trigger: 'manual' }
	| {
			phase: 'recording';
			trigger: 'vad';
			/** VAD has latched onto speech: light the meter past mere loudness. */
			isSpeaking: boolean;
			/** A previous phrase is still transcribing beside the live meter. */
			isTranscribing: boolean;
	  }
	| { phase: 'transcribing' }
	| { phase: 'polishing' }
	| { phase: 'delivered'; reach: DeliveryReach }
	| { phase: 'failed'; tier: DictationFailureTier };

/** A control gesture emitted by either mount of the shared recording pill. */
export type RecordingPillAction = 'stop' | 'cancel' | 'ship-raw';
