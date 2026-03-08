import { createPlaySoundServiceDesktop } from './desktop';
import { createPlaySoundServiceWeb } from './web';

export type { AvailableSound, PlaySoundService, SoundError } from './types';
export type { SoundId, SoundSource } from './sound-registry';
export {
	getAllBundledSounds,
	getBundledSoundsForEvent,
	getDefaultBundledSoundId,
	getBundledEventFromId,
	isBundledSoundId,
} from './sound-registry';

export const PlaySoundServiceLive = window.__TAURI_INTERNALS__
	? createPlaySoundServiceDesktop()
	: createPlaySoundServiceWeb();
