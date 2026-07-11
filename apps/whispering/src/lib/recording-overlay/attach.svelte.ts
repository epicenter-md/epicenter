import type { UnlistenFn } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
	currentMonitor,
	getCurrentWindow,
	LogicalPosition,
	primaryMonitor,
} from '@tauri-apps/api/window';
import { createLogger } from 'wellcrafted/logger';
import type { RecordingPillStatus } from '$lib/recording-pill/model';
import { dispatchPillAction } from '$lib/recording-pill/pill-actions';
import { projectLifecycleToStatus } from '$lib/recording-pill/projection';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import {
	RECORDING_OVERLAY_WINDOW_LABEL,
	recordingOverlayAction,
	recordingOverlayReady,
	recordingOverlayStatus,
	revealMainWindow,
} from './events';

const log = createLogger('whispering/recording-overlay');
const OVERLAY_WIDTH = 224;
const OVERLAY_HEIGHT = 40;
const OVERLAY_BOTTOM_MARGIN = 72;

async function computePosition(): Promise<LogicalPosition | null> {
	const monitor = (await currentMonitor()) ?? (await primaryMonitor());
	if (!monitor) return null;
	const scale = monitor.scaleFactor;
	return new LogicalPosition(
		monitor.position.x / scale +
			(monitor.size.width / scale - OVERLAY_WIDTH) / 2,
		monitor.position.y / scale +
			monitor.size.height / scale -
			OVERLAY_HEIGHT -
			OVERLAY_BOTTOM_MARGIN,
	);
}

/** Attach Whispering's state projection to Epicenter's native overlay window. */
export function attachRecordingOverlay(): () => void {
	const overlay = WebviewWindow.getByLabel(RECORDING_OVERLAY_WINDOW_LABEL);
	const mainWindow = getCurrentWindow();
	const unlisteners: UnlistenFn[] = [];
	let destroyed = false;
	let latestStatus: RecordingPillStatus | null = null;
	let queue = Promise.resolve();

	function track(unlisten: UnlistenFn) {
		if (destroyed) unlisten();
		else unlisteners.push(unlisten);
	}

	async function apply(status: RecordingPillStatus | null) {
		const window = await overlay;
		if (!window || status !== latestStatus) return;
		if (!status) {
			await window.hide();
			return;
		}
		const position = await computePosition();
		if (status !== latestStatus) return;
		if (position) await window.setPosition(position);
		if (status !== latestStatus) return;
		await window.show();
		if (status === latestStatus) await recordingOverlayStatus.emit(status);
	}

	function synchronize(status: RecordingPillStatus | null) {
		latestStatus = status;
		queue = queue
			.then(() => apply(status))
			.catch((error) => {
				log.warn(error instanceof Error ? error : new Error(String(error)));
			});
	}

	const status = $derived(projectLifecycleToStatus(dictationLifecycle.current));
	$effect(() => synchronize(status));

	void recordingOverlayReady
		.listen(() => {
			if (latestStatus) void recordingOverlayStatus.emit(latestStatus);
		})
		.then(track);
	void recordingOverlayAction
		.listen(({ payload }) => dispatchPillAction(payload))
		.then(track);
	void revealMainWindow
		.listen(async () => {
			await mainWindow.show();
			await mainWindow.unminimize();
			await mainWindow.setFocus().catch(() => {});
		})
		.then(track);

	return () => {
		destroyed = true;
		for (const unlisten of unlisteners) unlisten();
		void overlay.then((window) => window?.hide());
	};
}
