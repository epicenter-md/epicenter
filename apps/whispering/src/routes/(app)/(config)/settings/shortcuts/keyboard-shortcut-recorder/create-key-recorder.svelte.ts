import type { KeyboardEventSupportedKey } from '$lib/constants/keyboard';
import type { PressedKeys } from '$lib/utils/createPressedKeys.svelte';
import { setRecordingMode } from '$lib/services/isomorphic/local-shortcut-manager';

const CAPTURE_WINDOW_MS = 600; // Increased from 300ms for complex shortcuts

/**
 * Creates a keyboard shortcut recorder that captures key combinations
 *
 * How it works:
 * 1. When recording starts, any pressed keys are captured
 * 2. Each new key extends a 300ms capture window
 * 3. The combination completes when:
 *    - All keys are released (immediate), OR
 *    - The capture window expires (300ms after last key)
 * 4. Escape key cancels recording at any time
 *
 * This approach handles all common patterns:
 * - Quick taps (Ctrl+C)
 * - Held modifiers (Cmd+Shift+P)
 * - Single keys (F5)
 * - Complex combinations built over time
 */
export function createKeyRecorder({
	pressedKeys,
	onRegister,
	onClear,
}: {
	pressedKeys: PressedKeys;
	onRegister: (keyCombination: KeyboardEventSupportedKey[]) => void;
	onClear: () => void;
}) {
	// State
	let isListening = $state(false);
	const capturedKeys = new Set<KeyboardEventSupportedKey>();
	let capturedKeysArray = $state<KeyboardEventSupportedKey[]>([]); // For UI preview
	let captureWindowTimer: NodeJS.Timeout | null = null;

	// Sync array with set for reactive UI
	$effect(() => {
		if (isListening) {
			capturedKeysArray = Array.from(capturedKeys);
		} else {
			capturedKeysArray = [];
		}
	});

	// Helper: Clear the capture window timer
	function clearCaptureTimer() {
		if (captureWindowTimer) {
			clearTimeout(captureWindowTimer);
			captureWindowTimer = null;
		}
	}

	// Helper: Complete the key combination
	function completeRecording() {
		if (!isListening || capturedKeys.size === 0) return;

		clearCaptureTimer();
		isListening = false;
		setRecordingMode(false);

		// Convert Set to Array for registration
		const combination = Array.from(capturedKeys);
		capturedKeys.clear();

		onRegister(combination);
	}

	// Main effect: Watch for key changes
	$effect(() => {
		if (!isListening) return;

		// Escape key cancels recording
		if (pressedKeys.current.includes('escape')) {
			isListening = false;
			clearCaptureTimer();
			capturedKeys.clear();
			return;
		}

		// Track new keys
		let hasNewKeys = false;
		for (const key of pressedKeys.current) {
			if (!capturedKeys.has(key)) {
				capturedKeys.add(key);
				hasNewKeys = true;
			}
		}

		// New keys extend the capture window
		if (hasNewKeys && capturedKeys.size > 0) {
			clearCaptureTimer();
			captureWindowTimer = setTimeout(completeRecording, CAPTURE_WINDOW_MS);
		}

		// All keys released = immediate completion
		if (pressedKeys.current.length === 0 && capturedKeys.size > 0) {
			completeRecording();
		}
	});

	// Public API
	return {
		get isListening() {
			return isListening;
		},
		get capturedKeys() {
			return capturedKeysArray;
		},
		start() {
			isListening = true;
			capturedKeys.clear();
			clearCaptureTimer();
			setRecordingMode(true);
		},
		stop() {
			isListening = false;
			capturedKeys.clear();
			clearCaptureTimer();
			setRecordingMode(false);
		},
		clear() {
			isListening = false;
			capturedKeys.clear();
			clearCaptureTimer();
			setRecordingMode(false);
			onClear();
		},
		register: onRegister,
	};
}

export type KeyRecorder = ReturnType<typeof createKeyRecorder>;
