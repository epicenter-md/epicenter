/**
 * Minimal background service worker.
 *
 * It owns no database. The open side panel document owns this origin's
 * Epicenter replica, because it owns the DedicatedWorker holding the one
 * exclusive Web Lock over the OPFS SQLite file (ADR-0165, amended by ADR-0177),
 * and MV3 gives a service worker no production lifetime guarantee. Browser
 * event listeners, sync, and the AI chat loop all live in the panel too.
 *
 * The only job here is opening that panel on action click.
 * `src/lib/ownership.test.ts` walks this module graph and fails if it ever
 * reaches a replica.
 */

import { defineBackground } from 'wxt/utils/define-background';

export default defineBackground(() => {
	// Open side panel when the extension icon is clicked (Chromium-based browsers).
	// Firefox uses sidebar_action manifest key: no runtime call needed.
	if (!import.meta.env.FIREFOX) {
		browser.sidePanel
			.setPanelBehavior({ openPanelOnActionClick: true })
			.catch((error: unknown) =>
				console.error('[Background] Failed to set panel behavior:', error),
			);
	}
});
