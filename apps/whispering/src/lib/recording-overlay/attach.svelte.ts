import type { UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from 'wellcrafted/logger';
import type { RecordingPillStatus } from '$lib/recording-pill/model';
import { dispatchPillAction } from '$lib/recording-pill/pill-actions';
import { projectLifecycleToStatus } from '$lib/recording-pill/projection';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import { commands } from '$lib/tauri/commands';
import {
	recordingOverlayAction,
	recordingOverlayReady,
	recordingOverlayStatus,
} from './events';

const log = createLogger('whispering/recording-overlay');

/** Attach Whispering's state projection to Epicenter's native overlay window. */
export function attachRecordingOverlay(): () => void {
	const unlisteners: UnlistenFn[] = [];
	let destroyed = false;
	let latestStatus: RecordingPillStatus | null = null;
	let queue = Promise.resolve();

	function track(unlisten: UnlistenFn) {
		if (destroyed) unlisten();
		else unlisteners.push(unlisten);
	}

	async function apply(status: RecordingPillStatus | null) {
		if (status !== latestStatus) return;
		const { error } = await commands.setRecordingOverlayVisible(
			status !== null,
		);
		if (error !== null) throw new Error(error);
		if (status && status === latestStatus) {
			await recordingOverlayStatus.emit(status);
		}
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
	return () => {
		destroyed = true;
		for (const unlisten of unlisteners) unlisten();
		void commands.setRecordingOverlayVisible(false);
	};
}
