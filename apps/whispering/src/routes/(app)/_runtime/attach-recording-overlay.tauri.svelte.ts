import type { UnlistenFn } from '@tauri-apps/api/event';
import {
	recordingOverlayAction,
	revealMainWindow,
} from '$lib/recording-overlay/events';
import { synchronizeRecordingOverlayWindow } from '$lib/recording-overlay/window-manager.tauri';
import { dispatchPillAction } from '$lib/recording-pill/pill-actions';
import { projectLifecycleToStatus } from '$lib/recording-pill/projection';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import { tauriOnly } from '$lib/tauri.tauri';
import type { RuntimeOwner } from './types';

/** Own the Tauri recording overlay for the app session. */
function attachRecordingOverlay() {
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
		synchronizeRecordingOverlayWindow(overlayStatus);
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

export const recordingOverlayRuntimeOwner: RuntimeOwner | null = {
	attach: attachRecordingOverlay,
};
