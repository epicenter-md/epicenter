import type { RecordingTrigger } from '$lib/constants/audio';

/**
 * Centralized view transition names for consistent cross-page animations.
 *
 * View transitions connect UI elements across pages. When two elements on different
 * pages share the same `view-transition-name`, the browser animates between them
 * during navigation.
 *
 * @example
 * ```svelte
 * <!-- Home page -->
 * <audio style="view-transition-name: {viewTransition.recording(id).audio}" />
 *
 * <!-- Recordings page -->
 * <audio style="view-transition-name: {viewTransition.recording(id).audio}" />
 * ```
 *
 * When navigating between pages, the audio element morphs smoothly.
 */
export const viewTransition = {
	/**
	 * Transition names for a specific recording's UI elements.
	 *
	 * @example
	 * ```svelte
	 * <audio style="view-transition-name: {viewTransition.recording(id).audio}" />
	 * <div style="view-transition-name: {viewTransition.recording(id).transcript}" />
	 * ```
	 */
	recording(id: string) {
		return {
			/** The audio player element */
			audio: `recording-${id}-audio`,
			/** The transcript text display */
			transcript: `recording-${id}-transcript`,
		} as const;
	},

	/**
	 * The selected recording trigger's mode glyph: the mic for `manual`, the ear
	 * for `vad`. The same glyph appears as a tab on the home page and as the
	 * topbar record button at rest, so sharing the name lets it slide across the
	 * home-to-config navigation.
	 *
	 * This morph is a recording-trigger affordance: the glyph *is* the action, so
	 * it stays the same object across pages. File import is deliberately not a
	 * trigger (it has no live capture, device, or shortcut), so its file-up glyph
	 * is incidental and does not participate here.
	 *
	 * Bind it to the glyph only at rest. Once a recording is live the topbar
	 * swaps to a stop control, which is a different object and must not inherit
	 * this name. Both home tabs render at once, but `manual` and `vad` are
	 * distinct names, so they never collide; the topbar carries only the
	 * selected one.
	 *
	 * @example
	 * ```svelte
	 * <MicIcon style="view-transition-name: {viewTransition.recordingMode('manual')}" />
	 * ```
	 */
	recordingMode(trigger: RecordingTrigger) {
		return `recording-mode-${trigger}` as const;
	},

	/**
	 * The capture pipeline's per-stage glyphs. Each stage's control is
	 * re-expressed in the home pipeline and the config topbar, so its glyph
	 * morphs between the two on navigation.
	 *
	 * Each name renders at most once per document because the home pipeline and
	 * the topbar never appear on the same page.
	 */
	pipeline: {
		/** The microphone device-selector glyph. */
		device: 'pipeline-device',
		/** The transcription service brand glyph. */
		transcription: 'pipeline-transcription',
	},
} as const;
