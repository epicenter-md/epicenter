/**
 * Audio Level Analyser Service
 *
 * Provides real-time audio level monitoring using Web Audio API's AnalyserNode.
 * Used for the recording indicator overlay to visualize voice input.
 *
 * IMPORTANT: Uses setInterval instead of requestAnimationFrame because:
 * - requestAnimationFrame is throttled/paused when window is not visible
 * - We need continuous analysis even when user is in another application
 */

import { emit } from '@tauri-apps/api/event';

type AudioAnalyserState = {
	audioContext: AudioContext | null;
	analyser: AnalyserNode | null;
	source: MediaStreamAudioSourceNode | null;
	intervalId: ReturnType<typeof setInterval> | null;
	isRunning: boolean;
	startTime: number | null;
};

const state: AudioAnalyserState = {
	audioContext: null,
	analyser: null,
	source: null,
	intervalId: null,
	isRunning: false,
	startTime: null,
};

// Update interval for emitting audio levels (ms)
// ~20fps for smooth animation
const UPDATE_INTERVAL_MS = 50;

/**
 * Start monitoring audio levels from a MediaStream
 */
export async function startAudioAnalysis(stream: MediaStream): Promise<void> {
	// Clean up any existing analyser
	await stopAudioAnalysis();

	try {
		// Create audio context
		state.audioContext = new AudioContext();
		state.analyser = state.audioContext.createAnalyser();

		// Configure analyser for responsive level detection
		state.analyser.fftSize = 256;
		state.analyser.smoothingTimeConstant = 0.5;

		// Connect stream to analyser
		state.source = state.audioContext.createMediaStreamSource(stream);
		state.source.connect(state.analyser);

		state.isRunning = true;
		state.startTime = Date.now();

		// Start the analysis loop with setInterval (works even when window not visible)
		state.intervalId = setInterval(analyseAndEmit, UPDATE_INTERVAL_MS);

		console.info('[AudioAnalyser] Started monitoring audio levels');
	} catch (error) {
		console.error('[AudioAnalyser] Failed to start:', error);
		await stopAudioAnalysis();
	}
}

/**
 * Stop monitoring audio levels
 */
export async function stopAudioAnalysis(): Promise<void> {
	state.isRunning = false;

	if (state.intervalId !== null) {
		clearInterval(state.intervalId);
		state.intervalId = null;
	}

	if (state.source) {
		state.source.disconnect();
		state.source = null;
	}

	if (state.analyser) {
		state.analyser.disconnect();
		state.analyser = null;
	}

	if (state.audioContext) {
		await state.audioContext.close().catch(() => {
			// Ignore close errors
		});
		state.audioContext = null;
	}

	state.startTime = null;

	console.info('[AudioAnalyser] Stopped monitoring');
}

/**
 * Analyse audio level and emit events
 * Called by setInterval for consistent updates regardless of window visibility
 */
function analyseAndEmit(): void {
	if (!state.isRunning || !state.analyser) {
		return;
	}

	const level = calculateAudioLevel();

	// Emit audio level for the recording indicator
	emit('audio-level-update', { level }).catch(() => {
		// Ignore emit errors (window might be closed)
	});

	// Emit elapsed time
	if (state.startTime) {
		const elapsedSeconds = Math.floor((Date.now() - state.startTime) / 1000);
		emit('recording-time-update', { seconds: elapsedSeconds }).catch(() => {});
	}
}

/**
 * Calculate normalized audio level (0-1) from frequency data
 */
function calculateAudioLevel(): number {
	if (!state.analyser) return 0;

	const bufferLength = state.analyser.frequencyBinCount;
	const dataArray = new Uint8Array(bufferLength);

	// Get frequency data
	state.analyser.getByteFrequencyData(dataArray);

	// Calculate RMS (root mean square) for more accurate level
	let sum = 0;
	for (let i = 0; i < bufferLength; i++) {
		const normalized = dataArray[i] / 255;
		sum += normalized * normalized;
	}
	const rms = Math.sqrt(sum / bufferLength);

	// Apply some gain and clamp to 0-1
	// The multiplier adjusts sensitivity
	const level = Math.min(1, rms * 2.5);

	return level;
}

/**
 * Check if audio analysis is currently running
 */
export function isAnalysing(): boolean {
	return state.isRunning;
}
