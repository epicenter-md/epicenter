import { Ok } from 'wellcrafted/result';
// import { extension } from '@epicenter/extension';
import type { PlaySoundService } from '.';
import { playSound } from './assets';

export function createPlaySoundServiceWeb() {
	return {
		playSound: async (soundName) => {
			if (!document.hidden) {
				await playSound(soundName);
				return Ok(undefined);
			}
			return Ok(undefined);
		},
	} satisfies PlaySoundService;
}
