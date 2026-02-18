import { Ok } from 'wellcrafted/result';
// import { extension } from '@epicenter/extension';
import type { PlaySoundService } from '.';
import { playSound } from './assets';

export function createPlaySoundServiceWeb(): PlaySoundService {
	return {
		playSound: async (soundName) => {
			if (!document.hidden) {
				await playSound(soundName);
				return Ok(undefined);
			}
			// const { error: playSoundError } = await extension.playSound({
			// 	sound: soundName,
			// });
			// if (playSoundError) {
			// 	return PlaySoundServiceErr(
			// 		`We encountered an issue while playing the ${soundName} sound`,
			// 		{
			// 			context: { soundName },
			// 			cause: playSoundError,
			// 		}
			// 	);
			// }
			return Ok(undefined);
		},
	};
}
