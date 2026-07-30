/** What Home may do natively, and how it knows whether it may (ADR-0189). */

import { invoke, isTauri } from '@tauri-apps/api/core';

/**
 * Whether this Home document is running inside the Epicenter desktop host.
 *
 * Synchronous on purpose: the host injects its IPC bootstrap before any module
 * runs, so the first paint already knows which pane to land on and which panes
 * can act. Home is also served to a plain browser and to a remote device
 * attached to the session, and neither can open a window or reach a
 * device-local model.
 */
export function isDesktopHost(): boolean {
	return isTauri();
}

/**
 * Reveal and focus one application's window, creating it the first time
 * (ADR-0189). The host resolves the ID against its own tables and derives the
 * URL and window label; Home passes an ID and nothing else.
 *
 * Home's verb, held by no other window. It is deliberately not the app-facing
 * `openApp(appId)` of ADR-0181, which targets an admitted catalog member only.
 */
export async function launchApplication(id: string): Promise<void> {
	await invoke('launch_application', { appId: id });
}
