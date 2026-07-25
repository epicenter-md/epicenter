import { Ok, type Result } from 'wellcrafted/result';
import type { WhisperingSoundNames } from '$lib/constants/sounds';
import { services } from '$lib/services';
import type { SoundError } from '$lib/services/sound';
import type { WhisperingApp } from '$lib/whispering/app';

const soundSettingKeyMap = {
	'manual-start': 'settings.sound.manualStart',
	'manual-stop': 'settings.sound.manualStop',
	'manual-cancel': 'settings.sound.manualCancel',
	'vad-start': 'settings.sound.vadStart',
	'vad-capture': 'settings.sound.vadCapture',
	'vad-stop': 'settings.sound.vadStop',
	transcriptionComplete: 'settings.sound.transcriptionComplete',
	recipeComplete: 'settings.sound.recipeComplete',
} as const satisfies Record<WhisperingSoundNames, string>;

export async function playSoundIfEnabled(
	app: WhisperingApp,
	soundName: WhisperingSoundNames,
): Promise<Result<void, SoundError>> {
	if (!app.settings.get(soundSettingKeyMap[soundName])) {
		return Ok(undefined);
	}
	return services.sound.playSound(soundName);
}
