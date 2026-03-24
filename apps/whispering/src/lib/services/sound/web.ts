import { Err, Ok } from 'wellcrafted/result';
// import { extension } from '@epicenter/extension';
import type { WhisperingSoundNames } from '$lib/constants/sounds';
import type { PlaySoundService } from '.';
import { audioElements, bundledSoundUrls } from './assets';
import {
	getBundledSoundsForEvent,
	getAllBundledSounds,
	getBundledEventFromId,
	getDefaultBundledSoundId,
	isBundledSoundId,
} from './sound-registry';
import type { SoundId } from './sound-registry';
import { SoundError } from './types';

function getBundledUrl(soundId: SoundId): string {
	if (!isBundledSoundId(soundId)) return '';
	const eventType = getBundledEventFromId(soundId);
	return eventType ? bundledSoundUrls[eventType] ?? '' : '';
}

export function createPlaySoundServiceWeb(): PlaySoundService {
	return {
		playSound: async (soundName, selectedSoundId) => {
			if (document.hidden) return Ok(undefined);
			const resolvedId = selectedSoundId ?? getDefaultBundledSoundId(soundName);
			// Fast path: bundled default for this event
			if (resolvedId === getDefaultBundledSoundId(soundName)) {
				try {
					await audioElements[soundName].play();
					return Ok(undefined);
				} catch (e) {
					return Err(SoundError.Play({ cause: e }));
				}
			}
			const url = getBundledUrl(resolvedId);
			if (!url) {
				try {
					await audioElements[soundName].play();
					return Ok(undefined);
				} catch (e) {
					return Err(SoundError.Play({ cause: e }));
				}
			}
			try {
				const audio = new Audio(url);
				await audio.play();
				return Ok(undefined);
			} catch (e) {
				try {
					await audioElements[soundName].play();
					return Ok(undefined);
				} catch (e2) {
					return Err(SoundError.Play({ cause: e2 }));
				}
			}
		},
		listAvailableSounds: async (eventType) => {
			const meta = eventType
				? getBundledSoundsForEvent(eventType)
				: getAllBundledSounds();
			const sounds = meta.map((s) => ({
				id: s.id,
				name: s.name,
				source: 'bundled' as const,
				eventTypes: [s.eventType],
				description: s.description,
			}));
			return Ok(sounds);
		},
		getSoundUrl: async (soundId) => {
			if (!isBundledSoundId(soundId)) {
				return Ok(''); // OS sounds not available on web
			}
			const eventType = getBundledEventFromId(soundId);
			if (!eventType) return Ok('');
			const url = bundledSoundUrls[eventType];
			return Ok(url ?? '');
		},
	};
}
