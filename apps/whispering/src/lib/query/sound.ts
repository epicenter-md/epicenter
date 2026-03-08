import { Ok, type Result } from 'wellcrafted/result';
import type { WhisperingSoundNames } from '$lib/constants/sounds';
import { defineMutation, defineQuery } from '$lib/query/client';
import { services } from '$lib/services';
import type {
	AvailableSound,
	SoundError,
	SoundId,
} from '$lib/services/sound';
import { settings } from '$lib/state/settings.svelte';

const soundKeys = {
	all: ['sound'] as const,
	playSoundIfEnabled: ['sound', 'playSoundIfEnabled'] as const,
	availableSounds: ['sound', 'availableSounds'] as const,
	previewSound: ['sound', 'previewSound'] as const,
} as const;

type WorkspaceSettingKey = Parameters<typeof settings.get>[0];

const soundToggleKeyMap = {
	'manual-start': 'sound.manualStart',
	'manual-stop': 'sound.manualStop',
	'manual-cancel': 'sound.manualCancel',
	'vad-start': 'sound.vadStart',
	'vad-capture': 'sound.vadCapture',
	'vad-stop': 'sound.vadStop',
	transcriptionComplete: 'sound.transcriptionComplete',
	transformationComplete: 'sound.transformationComplete',
} as const satisfies Record<WhisperingSoundNames, WorkspaceSettingKey>;

export const sound = {
	playSoundIfEnabled: defineMutation({
		mutationKey: soundKeys.playSoundIfEnabled,
		mutationFn: async (
			soundName: WhisperingSoundNames,
		): Promise<Result<void, SoundError>> => {
			if (!settings.get(soundToggleKeyMap[soundName])) {
				return Ok(undefined);
			}
			const selectedSoundId = settings.get(
				`sound.selectedSound.${soundName}` as WorkspaceSettingKey,
			) as SoundId | undefined;
			return await services.sound.playSound(soundName, selectedSoundId);
		},
	}),
	listAvailableSounds: defineQuery({
		queryKey: soundKeys.availableSounds,
		queryFn: async (): Promise<Result<AvailableSound[], SoundError>> =>
			services.sound.listAvailableSounds(),
	}),
	previewSound: defineMutation({
		mutationKey: soundKeys.previewSound,
		mutationFn: async (soundId: SoundId): Promise<Result<void, SoundError>> => {
			const urlResult = await services.sound.getSoundUrl(soundId);
			if (urlResult.error || !urlResult.data) return Ok(undefined);
			const audio = new Audio(urlResult.data);
			await audio.play();
			return Ok(undefined);
		},
	}),
};
