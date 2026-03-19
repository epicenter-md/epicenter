import * as Y from 'yjs';

/** Origin sentinel — updates applied from the BroadcastChannel carry this
 *  so the `updateV2` handler skips re-broadcasting them (prevents echo loops). */
const BC_ORIGIN = Symbol('bc-sync');

/**
 * BroadcastChannel cross-tab sync for a Yjs document.
 *
 * Broadcasts every local `updateV2` to same-origin tabs and applies incoming
 * updates from other tabs. Uses `ydoc.guid` (= workspace ID) as the channel
 * name so only docs for the same workspace communicate.
 *
 * Yjs deduplicates internally—if the WebSocket provider delivers the same
 * update, `applyUpdateV2` with an already-applied state vector is a no-op.
 * Running BroadcastChannel alongside WebSocket is safe and intended.
 *
 * No-ops gracefully when `BroadcastChannel` is unavailable (Node.js, SSR,
 * older browsers).
 *
 * Works directly as an extension factory — destructures `ydoc` from the
 * workspace client context. Chain after persistence and before WebSocket
 * sync for optimal ordering: local state loads first, then instant local
 * sync, then server sync.
 *
 * @example Persistence + BroadcastChannel + WebSocket (recommended)
 * ```typescript
 * import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
 * import { broadcastChannelSync } from '@epicenter/workspace/extensions/sync/broadcast-channel';
 * import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
 *
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('broadcast', broadcastChannelSync)
 *   .withWorkspaceExtension('sync', createSyncExtension({
 *     url: (id) => `http://localhost:3913/rooms/${id}`,
 *   }))
 * ```
 *
 * @example Standalone (no server, local tabs only)
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('broadcast', broadcastChannelSync)
 * ```
 */
export function broadcastChannelSync({ ydoc }: { ydoc: Y.Doc }) {
	if (typeof BroadcastChannel === 'undefined') return {};

	const channel = new BroadcastChannel(`yjs:${ydoc.guid}`);

	/** Broadcast local changes to other tabs. */
	const handleUpdate = (update: Uint8Array, origin: unknown) => {
		if (origin === BC_ORIGIN) return;
		channel.postMessage(update);
	};
	ydoc.on('updateV2', handleUpdate);

	/** Apply incoming changes from other tabs. */
	channel.onmessage = (event: MessageEvent) => {
		Y.applyUpdateV2(ydoc, new Uint8Array(event.data), BC_ORIGIN);
	};

	return {
		destroy() {
			ydoc.off('updateV2', handleUpdate);
			channel.close();
		},
	};
}
