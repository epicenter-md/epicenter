import type { WhisperingSoundNames } from '$lib/constants/sounds';
import {
	default as captureVadSoundSrc,
	default as stopManualSoundSrc,
} from './sound_ex_machina_Button_Blip.mp3';
import startManualSoundSrc from './zapsplat_household_alarm_clock_button_press_12967.mp3';
import stopVadSoundSrc from './zapsplat_household_alarm_clock_large_snooze_button_press_001_12968.mp3';
import startVadSoundSrc from './zapsplat_household_alarm_clock_large_snooze_button_press_002_12969.mp3';
import cancelSoundSrc from './zapsplat_multimedia_click_button_short_sharp_73510.mp3';
import transformationCompleteSoundSrc from './zapsplat_multimedia_notification_alert_ping_bright_chime_001_93276.mp3';
import transcriptionCompleteSoundSrc from './zapsplat_multimedia_ui_notification_classic_bell_synth_success_107505.mp3';

// Map each sound name to its source URL. Audio elements are created on demand
// and released after playback so PipeWire nodes don't accumulate.
const soundSources = {
	'manual-start': startManualSoundSrc,
	'manual-cancel': cancelSoundSrc,
	'manual-stop': stopManualSoundSrc,
	'vad-start': startVadSoundSrc,
	'vad-capture': captureVadSoundSrc,
	'vad-stop': stopVadSoundSrc,
	transcriptionComplete: transcriptionCompleteSoundSrc,
	transformationComplete: transformationCompleteSoundSrc,
} satisfies Record<WhisperingSoundNames, string>;

/**
 * Play a sound effect and release the PipeWire node once playback finishes.
 *
 * Each HTMLAudioElement registers a PipeWire output node that persists as long
 * as the element is reachable. To prevent nodes from accumulating we clear the
 * src after the sound ends, which tears down the underlying media resource.
 */
export async function playSound(
	soundName: WhisperingSoundNames,
): Promise<void> {
	const el = new Audio(soundSources[soundName]);
	await el.play();
	await new Promise<void>((resolve) => {
		el.addEventListener(
			'ended',
			() => {
				el.src = '';
				el.load();
				resolve();
			},
			{ once: true },
		);
	});
}
