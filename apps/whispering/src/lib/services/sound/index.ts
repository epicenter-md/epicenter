import { createPlaySoundServiceWebAudio } from './web-audio';

export type { PlaySoundService, PlaySoundServiceError } from './types';

// Use Web Audio API for both desktop and web browser environments
export const PlaySoundServiceLive = createPlaySoundServiceWebAudio();
