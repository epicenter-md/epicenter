import { tryAsync } from 'wellcrafted/result';
import type { PlaySoundService } from '.';
import { audioElements } from './assets';
import { PlaySoundServiceErr } from './types';

// Map sound names to their source files using existing audioElements
const soundSources = {
	'manual-start': audioElements['manual-start'].src,
	'manual-cancel': audioElements['manual-cancel'].src,
	'manual-stop': audioElements['manual-stop'].src,
	'vad-start': audioElements['vad-start'].src,
	'vad-capture': audioElements['vad-capture'].src,
	'vad-stop': audioElements['vad-stop'].src,
	transcriptionComplete: audioElements.transcriptionComplete.src,
	transformationComplete: audioElements.transformationComplete.src,
} as const;

/**
 * Create a fresh AudioContext per play. We close it after each use to avoid
 * sleep/wake issues (long-running contexts can break after the machine wakes).
 */
function createContext(): AudioContext {
	return new AudioContext();
}

async function closeContext(context: AudioContext): Promise<void> {
	try {
		await context.close();
	} catch (error) {
		console.error('[WebAudio] Failed to close AudioContext:', error);
	}
}

/**
 * Decode audio for playback. No caching: AudioBuffers are tied to the context
 * that decoded them. Since we close the context after each play, cached buffers
 * would become invalid and cause wrong/partial/wrong-sound playback.
 */
async function decodeAudio(
	audioSrc: string,
	context: AudioContext,
): Promise<AudioBuffer> {
	const response = await fetch(audioSrc);
	if (!response.ok) {
		throw new Error(`Failed to fetch audio: ${response.statusText}`);
	}
	const arrayBuffer = await response.arrayBuffer();
	return context.decodeAudioData(arrayBuffer);
}

async function playSoundWithWebAudio(audioSrc: string): Promise<void> {
	const context = createContext();

	try {
		if (context.state === 'suspended') {
			await context.resume();
		}

		const audioBuffer = await decodeAudio(audioSrc, context);
		const source = context.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(context.destination);

		await new Promise<void>((resolve, reject) => {
			source.onended = () => resolve();
			source.onerror = (e) => reject(e);
			source.start();
		});
	} finally {
		await closeContext(context);
	}
}

export function createPlaySoundServiceWebAudio(): PlaySoundService {
	return {
		playSound: async (soundName) =>
			tryAsync({
				try: async () => {
					const audioSrc = soundSources[soundName];
					if (!audioSrc) {
						throw new Error(`Unknown sound: ${soundName}`);
					}

					await playSoundWithWebAudio(audioSrc);
				},
				mapErr: (error) => {
					console.error('[WebAudio] PlaySound service error:', error);
					return PlaySoundServiceErr({
						message: 'Failed to play sound with Web Audio API',
						context: { soundName },
						cause: error,
					});
				},
			}),
	};
}
