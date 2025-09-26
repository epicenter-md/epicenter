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

// AudioContext management
let audioContext: AudioContext | null = null;
const audioBufferCache = new Map<string, AudioBuffer>();

// Get or create a working AudioContext
function getAudioContext(): AudioContext {
	// If context doesn't exist or is closed, create a new one
	if (!audioContext || audioContext.state === 'closed') {
		console.log('[WebAudio] Creating new AudioContext');
		audioContext = new AudioContext();
	}
	return audioContext;
}

// Ensure AudioContext is in a playable state
async function ensureAudioContextReady(): Promise<AudioContext> {
	const context = getAudioContext();
	
	// Handle suspended state (common after system sleep or audio routing changes)
	if (context.state === 'suspended') {
		console.log('[WebAudio] AudioContext suspended, attempting to resume...');
		try {
			await context.resume();
			console.log('[WebAudio] AudioContext resumed successfully');
		} catch (error) {
			console.error('[WebAudio] Failed to resume AudioContext:', error);
			// If resume fails, create a new context
			audioContext = new AudioContext();
			console.log('[WebAudio] Created new AudioContext after resume failure');
		}
	}
	
	// Handle running state
	if (context.state === 'running') {
		console.log('[WebAudio] AudioContext is ready');
		return context;
	}
	
	// If we get here, something is wrong - create a new context
	console.warn('[WebAudio] AudioContext in unexpected state:', context.state);
	audioContext = new AudioContext();
	return audioContext;
}

// Load and decode an audio file
async function loadAudioBuffer(audioSrc: string): Promise<AudioBuffer> {
	// Check cache first
	if (audioBufferCache.has(audioSrc)) {
		return audioBufferCache.get(audioSrc)!;
	}

	console.log('[WebAudio] Loading audio buffer:', audioSrc);
	
	try {
		// Fetch the audio file
		const response = await fetch(audioSrc);
		if (!response.ok) {
			throw new Error(`Failed to fetch audio: ${response.statusText}`);
		}
		
		const arrayBuffer = await response.arrayBuffer();
		const context = getAudioContext();
		const audioBuffer = await context.decodeAudioData(arrayBuffer);
		
		// Cache the decoded buffer
		audioBufferCache.set(audioSrc, audioBuffer);
		console.log('[WebAudio] Audio buffer loaded and cached');
		
		return audioBuffer;
	} catch (error) {
		console.error('[WebAudio] Failed to load audio buffer:', error);
		throw error;
	}
}

// Play a sound using Web Audio API (doesn't register with media controls)
async function playSoundWithWebAudio(audioSrc: string): Promise<void> {
	console.log('[WebAudio] Playing sound:', audioSrc);
	
	try {
		// Ensure context is ready
		const context = await ensureAudioContextReady();
		
		// Load the audio buffer
		const audioBuffer = await loadAudioBuffer(audioSrc);
		
		// Create and play the sound
		const source = context.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(context.destination);
		
		// Add completion handler for the source
		source.onended = () => {
			console.log('[WebAudio] Sound playback completed');
		};
		
		source.start();
		console.log('[WebAudio] Sound playback started');
		
	} catch (error) {
		console.error('[WebAudio] Failed to play sound:', error);
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
