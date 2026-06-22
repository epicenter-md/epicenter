import { createMutation } from '@tanstack/svelte-query';
import { MANUAL_RECORDING_BUTTON } from '$lib/constants/audio';
import {
	startManualRecording,
	stopManualRecording,
} from '$lib/operations/recording';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { getRecordingShortcutLabel } from '$lib/utils/recording-shortcut';

/**
 * The shared manual-record button behavior: the start/stop mutations plus every
 * prop a `RecordingActionCard` needs, all derived from the one `manualRecorder`
 * state machine. The home recorder and the first-run "try it" step both call
 * this so the button looks and behaves identically, instead of each
 * re-implementing the wiring (and, in the wizard's case, faking the states).
 *
 * Start and stop are separate mutations on purpose: `stopManualRecording` awaits
 * the full transcription pipeline, so its pending window outlives the RECORDING
 * state (the recorder resets to IDLE the moment the mic stops, while
 * transcription is still running). Deriving direction from `manualRecorder.state`
 * alone would mislabel that post-stop window as "starting".
 *
 * Call from a component's init: it creates TanStack mutations, which need the
 * component query-client context.
 */
export function createManualRecordingController() {
	const startMutation = createMutation(() => ({
		mutationFn: startManualRecording,
	}));
	const stopMutation = createMutation(() => ({
		mutationFn: stopManualRecording,
	}));

	const isStarting = $derived(startMutation.isPending);
	const isStopping = $derived(stopMutation.isPending);
	const isRecording = $derived(manualRecorder.state === 'RECORDING');
	const button = $derived(MANUAL_RECORDING_BUTTON[manualRecorder.state]);
	const shortcutLabel = $derived(getRecordingShortcutLabel('manual'));

	const description = $derived.by(() => {
		if (isStarting) return 'Opening microphone input';
		if (isStopping) return 'Stopping recording';
		if (isRecording) return 'Click again to stop';
		return shortcutLabel ? 'Click or press shortcut' : 'Click to record';
	});
	const tooltip = $derived.by(() => {
		if (isStarting) return 'Preparing recording controls';
		if (isStopping) return 'Stopping recording';
		return button.label;
	});

	return {
		/** Recording right now: drives the card's destructive "filled" treatment. */
		get active() {
			return isRecording;
		},
		/** Mid start or mid stop: drives the card's spinner. */
		get pending() {
			return isStarting || isStopping;
		},
		get isRecording() {
			return isRecording;
		},
		/** True once a stop has fully resolved, i.e. transcription is done. */
		get justRecorded() {
			return stopMutation.isSuccess;
		},
		get icon() {
			return button.Icon;
		},
		get label() {
			return button.label;
		},
		get description() {
			return description;
		},
		get tooltip() {
			return tooltip;
		},
		get shortcutLabel() {
			return shortcutLabel;
		},
		toggle() {
			if (isRecording) stopMutation.mutate();
			else startMutation.mutate();
		},
	};
}
