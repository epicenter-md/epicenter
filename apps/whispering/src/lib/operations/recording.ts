import type { DeviceAcquisitionOutcome } from '@epicenter/recorder';
import { nanoid } from 'nanoid/non-secure';
import { manualRecorderConfig } from '#platform/manual-recorder-config';
import { reportRecordingMicLevel } from '#platform/recording-mic-level';
import { goto } from '$app/navigation';
import type { CaptureSurface } from '$lib/constants/audio';
import { whisperingPath } from '$lib/constants/urls';
import { analytics } from '$lib/operations/analytics';
import { recordingMedia } from '$lib/operations/media';
import { processRecordingPipeline } from '$lib/operations/pipeline';
import { sound } from '$lib/operations/sound';
import { prewarmOnDeviceModel } from '$lib/operations/transcribe';
import { log, report } from '$lib/report';
import { captureSurface } from '$lib/state/capture-surface.svelte';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { settings } from '$lib/state/settings.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

/**
 * Surface the outcome of acquiring a recording device. A clean success is
 * silent (the pill is the in-flight feedback). A fallback to a different
 * microphone is a standing config notice the pill cannot carry, so it is
 * reported here, and the chosen device is persisted so the next session keeps
 * it.
 */
function reportDeviceAcquisitionOutcome(
	outcome: DeviceAcquisitionOutcome,
	persist: (deviceId: string) => void,
): void {
	if (outcome.outcome === 'success') return;

	persist(outcome.deviceId);
	switch (outcome.reason) {
		case 'no-device-selected':
			report.info({
				title: 'Switched to available microphone',
				description:
					'No microphone was selected, so we automatically connected to an available one. You can update your selection in settings.',
				action: {
					label: 'Open Settings',
					onClick: () => goto(whisperingPath('/settings/recording')),
				},
			});
			return;
		case 'preferred-device-unavailable':
			report.info({
				title: 'Switched to different microphone',
				description:
					"Your previously selected microphone wasn't found, so we automatically connected to an available one.",
				action: {
					label: 'Open Settings',
					onClick: () => goto(whisperingPath('/settings/recording')),
				},
			});
			return;
	}
}

function isVadRecordingActive() {
	return (
		vadRecorder.state === 'LISTENING' || vadRecorder.state === 'SPEECH_DETECTED'
	);
}

/**
 * Start a manual recording and return the id of the recording it started, or
 * `null` when it did not start one (it failed, or a recording was already live so
 * this call was a no-op). Push-to-talk remembers that id to later stop only the
 * exact recording it owns; the button and toggle paths ignore the return.
 */
export async function startManualRecording(): Promise<string | null> {
	settings.set('recording.trigger', 'manual');
	// A new dictation is starting: clear any lingering failed/delivered state so
	// the pill follows this attempt, not the last one.
	dictationLifecycle.reset();
	// A capture just started, so leave the import overlay if it was open: the
	// surface should follow the live recording, not stay parked on import.
	captureSurface.dismissImport();

	// Kick off the local model load now, concurrently with bringing up the
	// recorder, so the ~1 s cold load overlaps the speech you're about to
	// record rather than being paid after you stop. No-op for cloud/web.
	prewarmOnDeviceModel();

	// Manual owns playback for the whole recording; drop any leftover VAD
	// per-utterance resume so it cannot fire mid-recording.
	cancelPendingVadResume();
	recordingMedia.pause();

	// Feed the pill's meter the live mic level. On web the navigator recorder taps
	// its stream to drive this; on desktop the CPAL worker emits the level from
	// Rust straight to the overlay, so this callback is never invoked there.
	const { data: outcome, error } = await manualRecorder.startRecording({
		onLevel: reportRecordingMicLevel,
	});

	if (error) {
		void recordingMedia.resume();
		// The recording never started, so there is no artifact to recover: the
		// loudest tier. The pill glances it and the OS notification always fires, so
		// there is no toast.
		dictationLifecycle.markFailed({ tier: 'silent-loss', error });
		return null;
	}

	// The pill shows the live recording; only a device fallback needs a notice.
	reportDeviceAcquisitionOutcome(outcome, (deviceId) => {
		manualRecorderConfig.deviceId = deviceId;
	});

	log.info('Recording started');
	sound.playSoundIfEnabled('manual-start');
	return manualRecorder.currentRecordingId;
}

export async function stopManualRecording() {
	const { data: source, error } = await manualRecorder.stopRecording();

	if (error) {
		void recordingMedia.resume();
		// Finalizing failed, so the captured audio never reached a row: treat it
		// as a silent loss rather than a retryable transcription.
		dictationLifecycle.markFailed({ tier: 'silent-loss', error });
		return;
	}

	const durationMs =
		source.kind === 'artifact' ? source.artifact.durationMs : source.durationMs;
	const byteLength =
		source.kind === 'artifact' ? source.artifact.byteLength : source.blob.size;

	// The pill carries "stopped -> transcribing"; the transcript landing is the
	// receipt. No per-step toast.
	log.info('Recording stopped');
	sound.playSoundIfEnabled('manual-stop');
	void recordingMedia.resume();

	analytics.logEvent({
		type: 'manual_recording_completed',
		blob_size: byteLength,
		duration: durationMs ?? undefined,
	});

	await processRecordingPipeline({
		source,
		durationMs,
	});
}

/**
 * Stop the manual recording only if `recordingId` names the one that is live. A
 * no-op otherwise, so a push-to-talk release that is stray, duplicated, or lands
 * after its recording was supplanted by a toggle/button recording never stops the
 * wrong one. This is the idempotent stop push-to-talk routes every stop through.
 */
export async function stopManualRecordingById(recordingId: string) {
	if (
		manualRecorder.state !== 'RECORDING' ||
		manualRecorder.currentRecordingId !== recordingId
	) {
		return;
	}
	await stopManualRecording();
}

export function toggleManualRecording() {
	if (manualRecorder.state === 'RECORDING') {
		return stopManualRecording();
	}
	return startManualRecording();
}

export async function cancelRecording() {
	// Note: distinct from the low-level Tauri `commands.cancelRecording()` (CPAL
	// stream teardown). This is the user-facing command: it decides what "cancel"
	// means across the manual and VAD recorders.
	//
	// Cancel aborts whichever capture is live, without touching
	// `recording.trigger`: the chosen trigger (manual vs VAD) is a deliberate
	// preference, not
	// something a cancel keystroke should flip, so cancelling in VAD mode leaves
	// you in VAD mode, idle and ready to listen again. This is also the global
	// cancel chord (Cmd + . on macOS), which the global-shortcut plugin fires only
	// on that exact chord, so when nothing is live it stays silent rather than
	// toasting on an unrelated press.

	// A manual recording is the live capture: discard it.
	const { data, error } = await manualRecorder.cancelRecording();
	if (error) {
		report.error({ title: 'Failed to cancel recording', cause: error });
		return;
	}
	if (data.status === 'cancelled') {
		void recordingMedia.resume();
		// The pill vanishing plus the cancel sound is the confirmation; no toast.
		sound.playSoundIfEnabled('manual-cancel');
		log.info('Recording cancelled');
		return;
	}

	// No manual recording, but a VAD session may be live. VAD has no
	// discard-vs-finalize split: tearing the session down is the only way to
	// abort it, which is exactly what stopVadRecording already does (same
	// stopActiveListening call, same end state, mode left on `vad`). So cancel a
	// live VAD session by stopping it, rather than cloning the teardown with a
	// second toast and a manual-recording sound. Nothing live: silent no-op.
	if (isVadRecordingActive()) await stopVadRecording();
}

// VAD pauses playback per utterance (the speaking window), not for the whole
// armed session: music keeps playing while you are armed-and-silent and stops
// only while you actually speak. A return to listening (speech end or a misfire)
// schedules a debounced resume so back-to-back utterances do not flutter the
// music; the next speech start cancels that pending resume. Ending the session
// resumes immediately. See ADR-0027.
let vadResumeTimer: ReturnType<typeof setTimeout> | undefined;
const VAD_RESUME_DELAY_MS = 1500;

function pausePlaybackForSpeech() {
	clearTimeout(vadResumeTimer);
	vadResumeTimer = undefined;
	recordingMedia.pause();
}

function scheduleResumeAfterSpeech() {
	clearTimeout(vadResumeTimer);
	vadResumeTimer = setTimeout(() => {
		vadResumeTimer = undefined;
		void recordingMedia.resume();
	}, VAD_RESUME_DELAY_MS);
}

/** Resume now and drop any pending debounce: the VAD session is ending. */
function resumePlaybackForVadEnd() {
	clearTimeout(vadResumeTimer);
	vadResumeTimer = undefined;
	void recordingMedia.resume();
}

/**
 * Drop a pending VAD resume without resuming. Used when a manual recording
 * starts: manual owns playback for its whole window, so a debounce left over
 * from a prior VAD utterance must not fire and resume music mid-recording.
 */
function cancelPendingVadResume() {
	clearTimeout(vadResumeTimer);
	vadResumeTimer = undefined;
}

export async function startVadRecording() {
	settings.set('recording.trigger', 'vad');
	// A new dictation session is starting: clear any lingering terminal state.
	dictationLifecycle.reset();
	// A capture just started, so leave the import overlay if it was open (see
	// startManualRecording).
	captureSurface.dismissImport();

	// Warm the local model when listening is armed (not when speech is
	// detected): arming VAD is the "about to dictate" signal, and starting the
	// load now means the model is ready before the first word, even for a short
	// utterance. No-op for cloud/web.
	prewarmOnDeviceModel();

	log.info('Starting voice activated capture');

	const { data: outcome, error } = await vadRecorder.startActiveListening({
		onLevel: reportRecordingMicLevel,
		onSpeechStart: () => {
			// Speaking window opened: pause whatever is playing. The pill's meter
			// tint shows speech was detected, so there is no toast.
			pausePlaybackForSpeech();
		},
		onSpeechEnd: async (blob) => {
			// Speaking window closed: resume after a short debounce so a quick
			// next utterance does not flutter the music.
			scheduleResumeAfterSpeech();
			log.info('Voice activated speech captured');
			sound.playSoundIfEnabled('vad-capture');

			analytics.logEvent({
				type: 'vad_recording_completed',
				blob_size: blob.size,
			});

			await processRecordingPipeline({
				source: {
					kind: 'blob',
					blob,
					recordingId: nanoid(),
					durationMs: null,
				},
				durationMs: null,
			});
		},
		onVADMisfire: () => {
			// False start: schedule the same debounced resume as a real speech
			// end, so an immediate retry does not flutter the music.
			scheduleResumeAfterSpeech();
		},
	});

	if (error) {
		resumePlaybackForVadEnd();
		// Listening never armed, so nothing was captured: a silent loss.
		dictationLifecycle.markFailed({ tier: 'silent-loss', error });
		return;
	}

	// The pill shows the armed session; only a device fallback needs a notice.
	reportDeviceAcquisitionOutcome(outcome, (deviceId) =>
		deviceConfig.set('recording.navigator.deviceId', deviceId),
	);

	sound.playSoundIfEnabled('vad-start');
}

export async function stopVadRecording() {
	if (!isVadRecordingActive()) return;

	log.info('Stopping voice activated capture');
	const { data, error } = await vadRecorder.stopActiveListening();
	// Disarming ends the session: restore playback now, do not wait on the
	// per-utterance debounce.
	resumePlaybackForVadEnd();
	if (error) {
		// Stop is an operation with no capture/outcome phase, so the pill cannot
		// carry it: a failed disarm keeps a toast (ADR-0039's operation-condition
		// carve-out). The session may still be live, so the user must know it did
		// not stop.
		report.error({
			title: "Couldn't stop voice activated capture",
			description: 'The session may still be running. Try stopping it again.',
			cause: error,
		});
		return;
	}
	if (data.status === 'idle') return;
	sound.playSoundIfEnabled('vad-stop');
}

export function toggleVadRecording() {
	if (isVadRecordingActive()) {
		return stopVadRecording();
	}
	return startVadRecording();
}

/**
 * Select a capture surface from the homepage tabs or the header dropdown.
 * `import` opens the transient import overlay without touching
 * `recording.trigger`; `manual`/`vad` close the overlay and switch the durable
 * trigger. Either way, a live capture on a different surface is stopped first so
 * two captures never overlap (`import` keeps neither recorder, so both stop).
 */
export async function selectCaptureSurface(surface: CaptureSurface) {
	// Flip the surface first so the tab/dropdown responds instantly; the live
	// capture stopped below finalizes and transcribes in the background rather
	// than blocking the switch.
	if (surface === 'import') {
		captureSurface.showImport();
	} else {
		captureSurface.dismissImport();
		if (settings.get('recording.trigger') !== surface) {
			settings.set('recording.trigger', surface);
		}
	}

	// Stop a live capture on a different surface so two captures never overlap
	// (`import` keeps neither recorder, so both stop). Stopping finalizes it: a
	// manual recording is saved and transcribed, and a voice-activated utterance
	// in progress is flushed through the pipeline (the VAD runs with
	// `submitUserSpeechOnPause`), so nothing you already said is lost.
	if (surface !== 'manual' && manualRecorder.state === 'RECORDING') {
		await stopManualRecording();
	}
	if (surface !== 'vad' && isVadRecordingActive()) {
		await stopVadRecording();
	}
}
