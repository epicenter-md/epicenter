import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Ok, tryAsync } from 'wellcrafted/result';
import { WHISPERING_SOUND_NAMES } from '$lib/constants/sounds';
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

async function getSoundUrlDesktop(soundId: SoundId): Promise<string> {
	if (isBundledSoundId(soundId)) {
		const eventType = getBundledEventFromId(soundId);
		if (!eventType) return '';
		return bundledSoundUrls[eventType] ?? '';
	}
	const osList = await invoke<{ id: string; name: string; path: string }[]>(
		'list_system_sounds',
	).catch(() => []);
	const entry = osList.find((s) => s.id === soundId);
	if (!entry) return '';
	return convertFileSrc(entry.path);
}

export function createPlaySoundServiceDesktop(): PlaySoundService {
	return {
		playSound: async (soundName, selectedSoundId) => {
			const resolvedId = selectedSoundId ?? getDefaultBundledSoundId(soundName);
			if (resolvedId === getDefaultBundledSoundId(soundName)) {
				return tryAsync({
					try: async () => {
						await audioElements[soundName].play();
					},
					catch: (error) => SoundError.Play({ cause: error }),
				});
			}
			const url = await getSoundUrlDesktop(resolvedId);
			if (!url) {
				return tryAsync({
					try: async () => {
						await audioElements[soundName].play();
					},
					catch: (error) => SoundError.Play({ cause: error }),
				});
			}
			try {
				const audio = new Audio(url);
				await audio.play();
				return Ok(undefined);
			} catch (e) {
				return tryAsync({
					try: async () => {
						await audioElements[soundName].play();
					},
					catch: (error) => SoundError.Play({ cause: error }),
				});
			}
		},
		listAvailableSounds: async (eventType) => {
			const bundledMeta = eventType
				? getBundledSoundsForEvent(eventType)
				: getAllBundledSounds();
			const bundled = bundledMeta.map((s) => ({
				id: s.id,
				name: s.name,
				source: 'bundled' as const,
				eventTypes: [s.eventType],
				description: s.description,
			}));
			const osList = await invoke<{ id: string; name: string; path: string }[]>(
				'list_system_sounds',
			).catch(() => [] as { id: string; name: string; path: string }[]);
			const osSounds = osList.map((s) => ({
				id: s.id as SoundId,
				name: s.name,
				source: 'os' as const,
				eventTypes: [...WHISPERING_SOUND_NAMES],
				description: undefined,
			}));
			return Ok([...bundled, ...osSounds]);
		},
		getSoundUrl: async (soundId) => {
			const url = await getSoundUrlDesktop(soundId);
			return Ok(url);
		},
	};
}
