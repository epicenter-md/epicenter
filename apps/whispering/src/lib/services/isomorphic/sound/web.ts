import { Ok } from 'wellcrafted/result';
import type { PlaySoundService } from '.';
import { getAudio } from './assets';

export function createPlaySoundServiceWeb(): PlaySoundService {
	return {
		playSound: async (soundName, { volume }) => {
			// Skip playing if the tab is not visible (browser autoplay restrictions)
			if (document.hidden) {
				return Ok(undefined);
			}

			const audio = await getAudio(soundName);
			audio.volume = volume;
			await audio.play();

			return Ok(undefined);
		},
	};
}
