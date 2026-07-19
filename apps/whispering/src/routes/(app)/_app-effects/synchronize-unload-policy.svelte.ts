import { tauri } from '#platform/tauri';
import { report } from '$lib/report';
import { deviceConfig } from '$lib/state/device-config.svelte';

/**
 * Reconcile the local-model unload policy into Rust's idle clock. The frontend
 * owns the value; Rust owns the clock (a backgrounded webview timer would
 * throttle exactly when idle-eviction must fire to reclaim RAM). This is the
 * only transcription setting still pushed to Rust: everything else travels with
 * each transcribe call as a per-call `TranscriptionSpec`, so it cannot go stale.
 * Desktop only: the browser build registers nothing.
 */
export function synchronizeUnloadPolicy(): void {
	if (!tauri) return;
	const t = tauri;

	$effect(() => {
		void t.transcription
			.setUnloadPolicy(deviceConfig.get('transcription.localModelUnloadPolicy'))
			.catch((cause) => {
				report.error({
					title: 'Failed to update local model unload policy',
					cause,
				});
			});
	});
}
