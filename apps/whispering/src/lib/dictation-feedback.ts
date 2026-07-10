import type { DictationFailureTier } from '$lib/state/dictation-lifecycle.svelte';

/**
 * The terse, glanceable name of each failure tier. The pill renders it as the
 * failed chip's label and the OS notification uses it as its title, so both
 * feedback surfaces share one closed token rather than transport-owned copy.
 */
export const DICTATION_FAILURE_LABEL = {
	'silent-loss': 'Recording failed',
	transcription: 'Transcription failed',
} satisfies Record<DictationFailureTier, string>;
