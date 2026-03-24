import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { WhisperingSoundNames } from '$lib/constants/sounds';
import type { SoundId } from './sound-registry';

export const SoundError = defineErrors({
	Play: ({ cause }: { cause: unknown }) => ({
		message: `Failed to play sound: ${extractErrorMessage(cause)}`,
		cause,
	}),
	Load: ({ cause }: { cause: unknown }) => ({
		message: `Failed to load sound: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type SoundError = InferErrors<typeof SoundError>;

export type AvailableSound = {
	id: SoundId;
	name: string;
	source: 'bundled' | 'os';
	eventTypes: WhisperingSoundNames[];
	description?: string;
};

export type PlaySoundService = {
	/** Plays the sound for the given event, using selectedSoundId if provided or default bundled sound. */
	playSound: (
		soundName: WhisperingSoundNames,
		selectedSoundId?: SoundId,
	) => Promise<Result<void, SoundError>>;
	listAvailableSounds: (
		eventType?: WhisperingSoundNames,
	) => Promise<Result<AvailableSound[], SoundError>>;
	getSoundUrl: (soundId: SoundId) => Promise<Result<string, SoundError>>;
};
