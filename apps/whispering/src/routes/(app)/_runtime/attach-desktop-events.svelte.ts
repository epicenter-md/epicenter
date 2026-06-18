import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { tauri } from '#platform/tauri';
import { goto } from '$app/navigation';
import { log, report } from '$lib/report';
import { dictationCapability } from '$lib/state/dictation-capability.svelte';
import { localModel } from '$lib/state/local-model.svelte';
import { checkForUpdates } from './check-for-updates';

export function attachDesktopEvents() {
	let unlistenNavigate: UnlistenFn | undefined;
	let unlistenPersistFailed: UnlistenFn | undefined;
	let unlistenLocalModel: UnlistenFn | undefined;
	let cleanupCapability: (() => void) | undefined;

	if (tauri) {
		void checkForUpdates();
		void (async () => {
			unlistenNavigate = await listen<{ path: string }>(
				'navigate-main-window',
				(event) => {
					goto(event.payload.path);
				},
			);
			// Rust persists the recording WAV off the critical path so the
			// transcript never waits on disk. If that write fails, the transcript
			// still landed (it came from the in-memory PCM handoff), so this is a
			// transient, non-blocking notice rather than a recording failure: the
			// only consequence is that this recording's audio is absent from
			// history.
			unlistenPersistFailed = await listen<{
				recordingId: string;
				error: string;
			}>('recorder:persist-failed', (event) => {
				log.warn(
					new Error(`Recording audio not saved: ${event.payload.error}`),
					event.payload,
				);
				report.info({
					title: 'Audio not saved',
					description:
						'Your transcript is ready, but the recording audio could not be saved, so it will not appear in history.',
				});
			});
			unlistenLocalModel = await localModel.attach();
			cleanupCapability = dictationCapability.attach();
		})();
	}

	return () => {
		unlistenNavigate?.();
		unlistenPersistFailed?.();
		unlistenLocalModel?.();
		cleanupCapability?.();
	};
}
