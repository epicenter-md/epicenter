import type { SoundName } from '$lib/constants/sounds';
import { DbServiceLive } from '../../db';
import buttonBlipSrc from './sound_ex_machina_Button_Blip.mp3';
import alarmButtonPressSrc from './zapsplat_household_alarm_clock_button_press_12967.mp3';
import snoozeButtonPress1Src from './zapsplat_household_alarm_clock_large_snooze_button_press_001_12968.mp3';
import snoozeButtonPress2Src from './zapsplat_household_alarm_clock_large_snooze_button_press_002_12969.mp3';
import shortClickSrc from './zapsplat_multimedia_click_button_short_sharp_73510.mp3';
import alertChimeSrc from './zapsplat_multimedia_notification_alert_ping_bright_chime_001_93276.mp3';
import bellSynthSrc from './zapsplat_multimedia_ui_notification_classic_bell_synth_success_107505.mp3';

/** Default bundled sound sources for each sound event */
const DEFAULT_SOUNDS: Record<SoundName, string> = {
	'manual-start': alarmButtonPressSrc,
	'manual-cancel': shortClickSrc,
	'manual-stop': buttonBlipSrc,
	'cpal-start': alarmButtonPressSrc,
	'cpal-cancel': shortClickSrc,
	'cpal-stop': buttonBlipSrc,
	'vad-start': snoozeButtonPress2Src,
	'vad-capture': buttonBlipSrc,
	'vad-stop': snoozeButtonPress1Src,
	'transcription-complete': bellSynthSrc,
	'transformation-complete': alertChimeSrc,
};

/**
 * Creates a fresh audio element for a sound.
 * Custom sounds from IndexedDB take priority over bundled defaults.
 * Browser HTTP cache handles bundled assets; blob URLs are cleaned up after playback.
 */
export async function getAudio(
	soundName: SoundName,
): Promise<HTMLAudioElement> {
	const { data: customBlob } = await DbServiceLive.sounds.get(soundName);

	if (customBlob) {
		const url = URL.createObjectURL(customBlob);
		const audio = new Audio(url);
		audio.onended = () => URL.revokeObjectURL(url);
		return audio;
	}

	return new Audio(DEFAULT_SOUNDS[soundName]);
}
