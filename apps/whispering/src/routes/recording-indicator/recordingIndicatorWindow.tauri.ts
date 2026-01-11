import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { currentMonitor } from '@tauri-apps/api/window';
import { Ok, tryAsync } from 'wellcrafted/result';

const WINDOW_LABEL = 'recording-indicator';
const WINDOW_WIDTH = 200;
const WINDOW_HEIGHT = 44;

let windowInstance: WebviewWindow | null = null;
let readyUnlisten: UnlistenFn | null = null;

/**
 * Shows the recording indicator overlay at the top center of the screen.
 * Creates the window on first call, then shows it for subsequent calls.
 * The window is always-on-top and doesn't steal focus.
 * Returns a promise that resolves when the window is ready to receive events.
 */
export async function show(): Promise<void> {
	const existingWindow = await WebviewWindow.getByLabel(WINDOW_LABEL);

	if (existingWindow) {
		// Reset the timer when showing existing window
		await emit('recording-indicator-reset');
		await existingWindow.show();
		windowInstance = existingWindow;
		return;
	}

	// Get current monitor to center the window
	const monitor = await currentMonitor();
	const screenWidth = monitor?.size.width ?? 1920;
	const scaleFactor = monitor?.scaleFactor ?? 1;

	// Calculate center position (accounting for DPI scaling)
	const x = Math.round((screenWidth / scaleFactor - WINDOW_WIDTH) / 2);
	const y = 16; // 16px from top

	// Create a promise that resolves when the window signals it's ready
	const windowReady = new Promise<void>((resolve) => {
		listen('recording-indicator-ready', () => {
			resolve();
		}).then((unlisten) => {
			readyUnlisten = unlisten;
		});

		// Timeout fallback in case the ready event doesn't fire
		setTimeout(() => resolve(), 500);
	});

	windowInstance = new WebviewWindow(WINDOW_LABEL, {
		url: '/recording-indicator',
		title: '', // No title
		width: WINDOW_WIDTH,
		height: WINDOW_HEIGHT,
		x,
		y,
		alwaysOnTop: true,
		decorations: false, // No window chrome
		transparent: true, // Transparent background
		resizable: false,
		skipTaskbar: true, // Don't show in taskbar
		focus: false, // Don't steal focus from current app
		visible: true,
		shadow: false, // We'll handle shadow in CSS
	});

	windowInstance.once('tauri://error', (error) => {
		console.error('Failed to create recording indicator window:', error);
		windowInstance = null;
	});

	// Wait for the window to be ready before returning
	await windowReady;
}

/**
 * Hides the recording indicator overlay (doesn't destroy for fast re-opening)
 */
export async function hide(): Promise<void> {
	const existingWindow = await WebviewWindow.getByLabel(WINDOW_LABEL);
	if (existingWindow) {
		await tryAsync({
			try: () => existingWindow.hide(),
			catch: (error) => {
				console.error('Error hiding recording indicator:', error);
				return Ok(undefined);
			},
		});
	}

	// Clean up ready listener
	if (readyUnlisten) {
		readyUnlisten();
		readyUnlisten = null;
	}
}

/**
 * Updates the audio level displayed in the indicator
 */
export async function updateAudioLevel(level: number): Promise<void> {
	await emit('audio-level-update', { level: Math.max(0, Math.min(1, level)) });
}

/**
 * Updates the recording state
 */
export async function updateState(
	state: 'recording' | 'processing' | 'idle',
): Promise<void> {
	await emit('recording-state-update', { state });
}
