import { Ok, type Result } from 'wellcrafted/result';
import type { WhisperingSoundNames } from '$lib/constants/sounds';
import { services } from '$lib/services';
import type { SoundError } from '$lib/services/sound';
import { settings } from '$lib/state/settings.svelte';

const soundSettingKeyMap = {
	'manual-start': 'sound.manualStart',
	'manual-stop': 'sound.manualStop',
	'manual-cancel': 'sound.manualCancel',
	'vad-start': 'sound.vadStart',
	'vad-capture': 'sound.vadCapture',
	'vad-stop': 'sound.vadStop',
	transcriptionComplete: 'sound.transcriptionComplete',
	recipeComplete: 'sound.recipeComplete',
} as const satisfies Record<WhisperingSoundNames, string>;

export const sound = {
	playSoundIfEnabled: async (
		soundName: WhisperingSoundNames,
	): Promise<Result<void, SoundError>> => {
		if (!settings.get(soundSettingKeyMap[soundName])) {
			return Ok(undefined);
		}
		return services.sound.playSound(soundName);
	},
};
