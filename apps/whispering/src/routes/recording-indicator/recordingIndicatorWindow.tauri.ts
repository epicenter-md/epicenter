import { emit } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { currentMonitor } from '@tauri-apps/api/window';
import { Ok, tryAsync } from 'wellcrafted/result';

const WINDOW_LABEL = 'recording-indicator';
const WINDOW_WIDTH = 220;
const WINDOW_HEIGHT = 48;

let windowInstance: WebviewWindow | null = null;

/**
 * Shows the recording indicator overlay at the top center of the screen.
 * Creates the window on first call, then shows it for subsequent calls.
 * The window is always-on-top and doesn't steal focus.
 */
export async function show(): Promise<void> {
	const existingWindow = await WebviewWindow.getByLabel(WINDOW_LABEL);

	if (existingWindow) {
		await existingWindow.show();
		await existingWindow.setFocus();
		windowInstance = existingWindow;
		return;
	}

	// Get current monitor to center the window
	const monitor = await currentMonitor();
	const screenWidth = monitor?.size.width ?? 1920;
	const scaleFactor = monitor?.scaleFactor ?? 1;

	// Calculate center position (accounting for DPI scaling)
	const x = Math.round((screenWidth / scaleFactor - WINDOW_WIDTH) / 2);
	const y = 20; // 20px from top

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

	// Emit event to start audio level updates
	await emit('recording-indicator-opened');
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
	// Emit event to stop audio level updates
	await emit('recording-indicator-closed');
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

/**
 * Updates the elapsed time
 */
export async function updateTime(seconds: number): Promise<void> {
	await emit('recording-time-update', { seconds });
}
