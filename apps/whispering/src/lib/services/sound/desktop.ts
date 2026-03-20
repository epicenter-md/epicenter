import { tryAsync } from 'wellcrafted/result';
import type { PlaySoundService } from '.';
import { playSound } from './assets';
import { SoundError } from './types';

export function createPlaySoundServiceDesktop(): PlaySoundService {
	return {
		playSound: async (soundName) =>
			tryAsync({
				try: () => playSound(soundName),
				catch: (error) => SoundError.Play({ cause: error }),
			}),
	};
}
