/**
 * Zhongwen browser composition.
 *
 * Single source of truth for "how Zhongwen mounts in a browser." Calls Tier 1
 * primitives inline so every line is visible top-to-bottom:
 *
 *  1. workspace root doc (encrypted tables + KV via createZhongwen)
 *  2. local storage + cloud sync for root (attachLocalStorage + openCollaboration)
 *  3. runtime storage + sync around the per-conversation transcript child docs
 *
 * `openCollaboration` owns reconnect-on-auth-change internally, so this file
 * has no per-app onStateChange listener. The bundle's `wipe()` drops every
 * encrypted IDB database for this owner; `Symbol.dispose` tears down the root
 * + cached child Y.Docs without touching local storage.
 */

import type { SignedIn } from '@epicenter/svelte';
import { ROOM_ROUTE } from '@epicenter/sync';
import {
	attachLocalStorage,
	clearLocalStorageForDoc,
	createDisposableCache,
	type DeviceId,
	defineWorkspace,
	openCollaboration,
	roomWsUrl,
	wipeLocalStorage,
} from '@epicenter/workspace';
import { defineErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import * as Y from 'yjs';
import {
	type ConversationId,
	createZhongwen,
	zhongwenConversationDocGuid,
} from './zhongwen';

const log = createLogger('zhongwen/browser');

const ZhongwenCleanupError = defineErrors({
	/**
	 * A deleted conversation's child doc could not be fully cleaned up. The local
	 * clear or the server room DELETE failed (e.g. offline). The conversation is
	 * already gone from the table; this leaves orphaned storage to reclaim later.
	 */
	ConversationCleanupFailed: ({
		cause,
		conversationId,
	}: {
		cause: unknown;
		conversationId: ConversationId;
	}) => ({
		message: `[zhongwen] failed to clean up deleted conversation ${conversationId}`,
		cause,
		conversationId,
	}),
});

export function openZhongwenBrowser({
	signedIn,
	deviceId,
}: {
	signedIn: SignedIn;
	deviceId: DeviceId;
}) {
	const workspace = createZhongwen({ keyring: signedIn.keyring });

	const idb = attachLocalStorage(workspace.ydoc, {
		server: signedIn.server,
		ownerId: signedIn.ownerId,
		keyring: signedIn.keyring,
	});
	const collaboration = openCollaboration(workspace.ydoc, {
		url: roomWsUrl({
			baseURL: signedIn.baseURL,
			ownerId: signedIn.ownerId,
			guid: workspace.ydoc.guid,
			deviceId,
		}),
		openWebSocket: signedIn.openWebSocket,
		onReconnectSignal: signedIn.onReconnectSignal,
		waitFor: idb.whenLoaded,
		actions: workspace.actions,
	});

	const conversationDocs = createDisposableCache(
		(conversationId: ConversationId) => {
			const ydoc = new Y.Doc({
				guid: zhongwenConversationDocGuid(conversationId),
				gc: true,
			});
			const childIdb = attachLocalStorage(ydoc, {
				server: signedIn.server,
				ownerId: signedIn.ownerId,
				keyring: signedIn.keyring,
			});
			// Transcripts sync through Cloud: that is what lets the server
			// generation actor stream assistant tokens into the doc and lets
			// every signed-in device watch them live.
			const childSync = openCollaboration(ydoc, {
				url: roomWsUrl({
					baseURL: signedIn.baseURL,
					ownerId: signedIn.ownerId,
					guid: ydoc.guid,
					deviceId,
				}),
				openWebSocket: signedIn.openWebSocket,
				onReconnectSignal: signedIn.onReconnectSignal,
				waitFor: childIdb.whenLoaded,
				actions: {},
			});
			return {
				ydoc,
				idb: childIdb,
				sync: childSync,
				/**
				 * Child disposer rejections do not propagate; bundle.wipe() relies on
				 * IDB's deleteDatabase native blocking as belt-and-suspenders for
				 * storage deletion.
				 */
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		},
	);

	// Deleting a conversation is a pure row tombstone (chat-state); the durable
	// child doc behind it lives in a separate local IDB database and a separate
	// server room, neither of which the row delete touches. This observer turns
	// the CRDT fact "a row disappeared" into the cleanup, on every device that
	// learns of the deletion (the deleter included), so cleanup converges without
	// a special deleter role. Reuses the deterministic child guid so the delete
	// path can't drift from the create path.
	const conversations = workspace.tables.conversations;
	const inFlightCleanups = new Set<ConversationId>();

	async function cleanupConversation(
		conversationId: ConversationId,
	): Promise<void> {
		if (inFlightCleanups.has(conversationId)) return;
		inFlightCleanups.add(conversationId);
		const guid = zhongwenConversationDocGuid(conversationId);
		try {
			// Dispose before clear: wait for any open handle to unmount so a live
			// persistence writer can't repopulate the database we are about to
			// delete. The cache is keyed by conversation id; resolves immediately
			// when nothing holds it.
			await conversationDocs.whenReleased(conversationId);
			await clearLocalStorageForDoc({
				server: signedIn.server,
				ownerId: signedIn.ownerId,
				guid,
			});
			// Idempotent server drop + tombstone. Best-effort: a failure here
			// (e.g. offline) leaves the room to reclaim later, never a hard error.
			await signedIn.fetch(
				ROOM_ROUTE.url(signedIn.baseURL, signedIn.ownerId, guid),
				{ method: 'DELETE' },
			);
		} catch (cause) {
			log.warn(
				ZhongwenCleanupError.ConversationCleanupFailed({
					cause,
					conversationId,
				}),
			);
		} finally {
			inFlightCleanups.delete(conversationId);
		}
	}

	const unobserveConversations = conversations.observe((changedIds) => {
		for (const id of changedIds) {
			if (!conversations.has(id)) void cleanupConversation(id);
		}
	});

	let docsTornDown = false;

	function teardownDocs() {
		if (docsTornDown) return;
		docsTornDown = true;
		unobserveConversations();
		conversationDocs[Symbol.dispose]();
		workspace[Symbol.dispose]();
	}

	return defineWorkspace({
		...workspace,
		idb,
		conversationDocs,
		collaboration,
		async wipe() {
			teardownDocs();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeLocalStorage({
				server: signedIn.server,
				ownerId: signedIn.ownerId,
			});
		},
		[Symbol.dispose]() {
			teardownDocs();
		},
	});
}

export type ZhongwenBrowser = ReturnType<typeof openZhongwenBrowser>;
