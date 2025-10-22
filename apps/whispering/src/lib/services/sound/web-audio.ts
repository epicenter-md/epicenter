import { tryAsync } from 'wellcrafted/result';
import type { PlaySoundService } from '.';
import { PlaySoundServiceErr } from './types';
import { audioElements } from './assets';

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

// Audio buffer cache (keep buffers cached, they're just data)
const audioBufferCache = new Map<string, AudioBuffer>();

// Create a fresh AudioContext (always new, never reuse)
function createFreshAudioContext(): AudioContext {
	console.log('[WebAudio] Creating fresh AudioContext');
	return new AudioContext();
}

// Destroy an AudioContext to clean up resources
async function destroyAudioContext(context: AudioContext): Promise<void> {
	try {
		console.log('[WebAudio] Destroying AudioContext');
		await context.close();
	} catch (error) {
		console.error('[WebAudio] Failed to destroy AudioContext:', error);
	}
}

// Load and decode an audio file
async function loadAudioBuffer(audioSrc: string, context: AudioContext): Promise<AudioBuffer> {
	// Check cache first
	if (audioBufferCache.has(audioSrc)) {
		return audioBufferCache.get(audioSrc)!;
	}

	try {
		// Fetch the audio file
		const response = await fetch(audioSrc);
		if (!response.ok) {
			throw new Error(`Failed to fetch audio: ${response.statusText}`);
		}
		
		const arrayBuffer = await response.arrayBuffer();
		const audioBuffer = await context.decodeAudioData(arrayBuffer);
		
		// Cache the decoded buffer
		audioBufferCache.set(audioSrc, audioBuffer);
		
		return audioBuffer;
	} catch (error) {
		throw error;
	}
}

// Play a sound using Web Audio API with fresh context (create, use, destroy pattern)
async function playSoundWithWebAudio(audioSrc: string): Promise<void> {
	
	// Step 1: Create a brand new AudioContext
	const context = createFreshAudioContext();
	
	try {
		// Step 2: Load the audio buffer (uses cache if available)
		const audioBuffer = await loadAudioBuffer(audioSrc, context);
		
		// Step 3: Create and configure the source
		const source = context.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(context.destination);
		
		// Step 4: Play the sound and wait for it to complete
		await new Promise<void>((resolve, reject) => {
			source.onended = () => {
				resolve();
			};
			
			source.onerror = (error) => {
				reject(error);
			};
			
			source.start();
		});
		
		// Step 5: Clean up - destroy the AudioContext immediately after playback
		await destroyAudioContext(context);
		
	} catch (error) {
		console.error('[WebAudio] Failed to play sound:', error);
		// Make sure to clean up even on error
		await destroyAudioContext(context);
		throw error;
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
