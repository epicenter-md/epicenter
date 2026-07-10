import type { UnlistenFn } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
	currentMonitor,
	LogicalPosition,
	primaryMonitor,
} from '@tauri-apps/api/window';
import { once } from 'wellcrafted/function';
import { createLogger } from 'wellcrafted/logger';
import { whisperingPath } from '$lib/constants/urls';
import {
	RECORDING_OVERLAY_WINDOW_LABEL,
	recordingOverlayAction,
	recordingOverlayReady,
	recordingOverlayStatus,
	revealMainWindow,
} from '$lib/recording-overlay/events';
import type { RecordingPillStatus } from '$lib/recording-pill/model';
import { dispatchPillAction } from '$lib/recording-pill/pill-actions';
import { projectLifecycleToStatus } from '$lib/recording-pill/projection';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import { tauriOnly } from '$lib/tauri.tauri';

const log = createLogger('whispering/recording-overlay');

// Fixed size in logical pixels. The width is the pill's max width (the cap in
// RecordingPill); the transparent window centers the narrower states inside it.
const OVERLAY_WIDTH = 224;
const OVERLAY_HEIGHT = 40;
// Distance from the bottom edge of the monitor, in logical pixels.
const OVERLAY_BOTTOM_MARGIN = 72;

let latestStatus: RecordingPillStatus | null = null;
let queue: Promise<void> = Promise.resolve();

async function computeOverlayPosition(): Promise<LogicalPosition | null> {
	const monitor = (await currentMonitor()) ?? (await primaryMonitor());
	if (!monitor) return null;

	const scale = monitor.scaleFactor;
	const monitorX = monitor.position.x / scale;
	const monitorY = monitor.position.y / scale;
	const monitorWidth = monitor.size.width / scale;
	const monitorHeight = monitor.size.height / scale;

	const x = monitorX + (monitorWidth - OVERLAY_WIDTH) / 2;
	const y = monitorY + monitorHeight - OVERLAY_HEIGHT - OVERLAY_BOTTOM_MARGIN;
	return new LogicalPosition(x, y);
}

/** Keep the ready listener live before a newly created overlay can emit. */
const ensureReadyListener = once(
	(): Promise<void> =>
		recordingOverlayReady
			.listen(() => {
				if (latestStatus) void recordingOverlayStatus.emit(latestStatus);
			})
			.then(() => undefined),
);

async function createOverlayWindow(): Promise<WebviewWindow | null> {
	await ensureReadyListener();
	const overlayUrl = new URL(
		whisperingPath('/recording-overlay'),
		window.location.origin,
	).href;

	const overlay = new WebviewWindow(RECORDING_OVERLAY_WINDOW_LABEL, {
		url: overlayUrl,
		title: 'Recording',
		width: OVERLAY_WIDTH,
		height: OVERLAY_HEIGHT,
		transparent: true,
		decorations: false,
		shadow: false,
		alwaysOnTop: true,
		visibleOnAllWorkspaces: true,
		skipTaskbar: true,
		resizable: false,
		maximizable: false,
		minimizable: false,
		closable: false,
		focus: false,
		focusable: false,
		visible: false,
	});

	return new Promise<WebviewWindow | null>((resolve) => {
		overlay.once('tauri://created', () => resolve(overlay));
		overlay.once('tauri://error', (event) => {
			log.warn(
				new Error(
					`Failed to create recording overlay window: ${JSON.stringify(event.payload)}`,
				),
			);
			resolve(null);
		});
	});
}

async function getOrCreateOverlayWindow(): Promise<WebviewWindow | null> {
	const existing = await WebviewWindow.getByLabel(
		RECORDING_OVERLAY_WINDOW_LABEL,
	);
	if (existing) return existing;
	return createOverlayWindow();
}

async function applyOverlayStatus(status: RecordingPillStatus | null) {
	const isSuperseded = () => status !== latestStatus;
	if (isSuperseded()) return;

	if (!status) {
		const overlay = await WebviewWindow.getByLabel(
			RECORDING_OVERLAY_WINDOW_LABEL,
		);
		if (overlay) await overlay.hide();
		return;
	}

	const overlay = await getOrCreateOverlayWindow();
	if (!overlay || isSuperseded()) return;

	const position = await computeOverlayPosition();
	if (isSuperseded()) return;
	if (position) await overlay.setPosition(position);
	if (isSuperseded()) return;

	await overlay.show();
	if (isSuperseded()) {
		if (!latestStatus) await overlay.hide();
		return;
	}

	await recordingOverlayStatus.emit(status);
}

/** Synchronize the native overlay without letting cosmetic failures stop capture. */
function synchronizeOverlayStatus(status: RecordingPillStatus | null): void {
	latestStatus = status;
	queue = queue
		.then(() => applyOverlayStatus(status))
		.catch((error) => {
			log.warn(error instanceof Error ? error : new Error(String(error)));
		});
}

/** Own the Tauri recording overlay for the app session. */
export function attachRecordingOverlay() {
	const unlisteners: UnlistenFn[] = [];
	let isDestroyed = false;
	const trackUnlistener = (unlisten: UnlistenFn) => {
		if (isDestroyed) unlisten();
		else unlisteners.push(unlisten);
	};

	const overlayStatus = $derived(
		projectLifecycleToStatus(dictationLifecycle.current),
	);

	$effect(() => {
		synchronizeOverlayStatus(overlayStatus);
	});

	void recordingOverlayAction
		.listen((event) => dispatchPillAction(event.payload))
		.then(trackUnlistener);
	void revealMainWindow
		.listen(() => tauriOnly.mainWindow.reveal())
		.then(trackUnlistener);

	return () => {
		isDestroyed = true;
		for (const unlisten of unlisteners) unlisten();
	};
}
