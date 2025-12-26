import type { SoundName } from '$lib/constants/sounds';
import type { SerializedAudio } from './recordings';

/**
 * How a custom sound is stored in IndexedDB (web platform).
 *
 * Desktop stores custom sounds as files in the custom-sounds directory,
 * so this type is only used by the web implementation.
 *
 * The `id` is the sound name (e.g., 'manual-start'), which serves as
 * the primary key. Audio is serialized to work around iOS Safari Blob
 * storage issues (same pattern as recordings).
 */
export type CustomSound = {
	id: SoundName;
	serializedAudio: SerializedAudio;
};
