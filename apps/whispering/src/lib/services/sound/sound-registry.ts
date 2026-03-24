/**
 * Central registry for bundled sound metadata.
 * Used by the UI to list sound options and by playback to resolve bundled sound IDs.
 */

import type { WhisperingSoundNames } from '$lib/constants/sounds';

export type SoundSource = 'bundled' | 'os';
export type SoundId = `${SoundSource}:${string}`;

export type BundledSoundMeta = {
	id: SoundId;
	name: string;
	eventType: WhisperingSoundNames;
	description?: string;
};

const BUNDLED_SOUNDS: BundledSoundMeta[] = [
	{ id: 'bundled:manual-start', name: 'Start', eventType: 'manual-start' },
	{ id: 'bundled:manual-stop', name: 'Stop', eventType: 'manual-stop' },
	{ id: 'bundled:manual-cancel', name: 'Cancel', eventType: 'manual-cancel' },
	{ id: 'bundled:vad-start', name: 'VAD start', eventType: 'vad-start' },
	{ id: 'bundled:vad-capture', name: 'VAD capture', eventType: 'vad-capture' },
	{ id: 'bundled:vad-stop', name: 'VAD stop', eventType: 'vad-stop' },
	{
		id: 'bundled:transcriptionComplete',
		name: 'Transcription complete',
		eventType: 'transcriptionComplete',
	},
	{
		id: 'bundled:transformationComplete',
		name: 'Transformation complete',
		eventType: 'transformationComplete',
	},
];

export function getBundledSoundsForEvent(
	eventType: WhisperingSoundNames,
): BundledSoundMeta[] {
	return BUNDLED_SOUNDS.filter((s) => s.eventType === eventType);
}

export function getAllBundledSounds(): BundledSoundMeta[] {
	return [...BUNDLED_SOUNDS];
}

export function getDefaultBundledSoundId(
	eventType: WhisperingSoundNames,
): SoundId {
	const found = BUNDLED_SOUNDS.find((s) => s.eventType === eventType);
	return found ? found.id : (`bundled:${eventType}` as SoundId);
}

export function isBundledSoundId(id: string): id is SoundId {
	return id.startsWith('bundled:');
}

export function getBundledEventFromId(soundId: SoundId): WhisperingSoundNames | null {
	const found = BUNDLED_SOUNDS.find((s) => s.id === soundId);
	return found ? found.eventType : null;
}
