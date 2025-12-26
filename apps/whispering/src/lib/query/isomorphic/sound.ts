import { Ok, type Result } from 'wellcrafted/result';
import type { SoundName } from '$lib/constants/sounds';
import { defineMutation } from '$lib/query/client';
import { services } from '$lib/services';
import type { PlaySoundServiceError } from '$lib/services/isomorphic/sound';
import { settings } from '$lib/stores/settings.svelte';

const soundKeys = {
	all: ['sound'] as const,
	playSoundIfEnabled: ['sound', 'playSoundIfEnabled'] as const,
} as const;

export const sound = {
	playSoundIfEnabled: defineMutation({
		mutationKey: soundKeys.playSoundIfEnabled,
		mutationFn: async (
			soundName: SoundName,
		): Promise<Result<void, PlaySoundServiceError>> => {
			const isSoundEnabled = settings.value[`sound.playOn.${soundName}`];

			// Skip playback if user has disabled this sound in settings
			if (!isSoundEnabled) return Ok(undefined);

			const volume = settings.value[`sound.volume.${soundName}`];
			return services.sound.playSound(soundName, { volume });
		},
	}),
};
