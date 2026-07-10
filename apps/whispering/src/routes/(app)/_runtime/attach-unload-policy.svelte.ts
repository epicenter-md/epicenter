import { tauri } from '#platform/tauri';
import { report } from '$lib/report';
import { deviceConfig } from '$lib/state/device-config.svelte';

/**
 * Reconcile the local-model unload policy into Rust's idle clock. The frontend
 * owns the value; Rust owns the clock (a backgrounded webview timer would
 * throttle exactly when idle-eviction must fire to reclaim RAM). This is the
 * only transcription setting still pushed to Rust: everything else travels with
 * each transcribe call as a per-call `TranscriptionSpec`, so it cannot go stale.
 */
export function attachUnloadPolicy() {
	$effect(() => {
		if (!tauri) return;

		void tauri.transcription
			.setUnloadPolicy(deviceConfig.get('transcription.localModelUnloadPolicy'))
			.catch((cause) => {
				report.error({
					title: 'Failed to update local model unload policy',
					cause,
				});
			});
	});

	return () => {};
}
