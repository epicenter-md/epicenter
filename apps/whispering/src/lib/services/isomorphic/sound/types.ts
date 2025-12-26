import { createTaggedError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { SoundName } from '$lib/constants/sounds';

export const { PlaySoundServiceError, PlaySoundServiceErr } = createTaggedError(
	'PlaySoundServiceError',
);
export type PlaySoundServiceError = ReturnType<typeof PlaySoundServiceError>;

export type PlaySoundOptions = {
	/** Volume level from 0.0 to 1.0 */
	volume: number;
};

export type PlaySoundService = {
	playSound: (
		soundName: SoundName,
		options: PlaySoundOptions,
	) => Promise<Result<void, PlaySoundServiceError>>;
};
