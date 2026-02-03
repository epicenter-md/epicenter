/**
 * Local dictation hooks: run custom commands when recording starts/stops.
 *
 * Config: ~/.epicenter/local.json with dictation_hooks. Status is run only on
 * start; the backend stores which hooks were toggled and runs on_stop_dictation
 * on stop (no second status check).
 *
 * Only runs in Tauri (desktop); no-op on web.
 */

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
	const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
	return tauriInvoke<T>(command, args);
}

export async function runOnStartDictation(_sessionId: string): Promise<void> {
	if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return;
	try {
		const toggled = await invoke<string[]>('epicenter_dictation_hooks_start');
		if (toggled.length > 0) {
			console.info('[dictation_hooks] toggled on start:', toggled);
		}
	} catch (e) {
		console.warn('[dictation_hooks] start failed', e);
	}
}

export async function runOnStopDictation(_sessionId: string): Promise<void> {
	if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return;
	try {
		await invoke('epicenter_dictation_hooks_stop');
		console.info('[dictation_hooks] ran on_stop (backend used stored list)');
	} catch (e) {
		console.warn('[dictation_hooks] stop failed', e);
	}
}
