/// <reference lib="dom" />

import {
	decodeRpcPayload,
	encodeAwareness,
	encodeAwarenessStates,
	encodeRpcRequest,
	encodeRpcResponse,
	encodeSyncStatus,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	isRpcError,
	MESSAGE_TYPE,
	RpcError,
	SYNC_MESSAGE_TYPE,
	type SyncMessageType,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import type { Result } from 'wellcrafted/result';
import { tryAsync } from 'wellcrafted/result';
import {
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from 'y-protocols/awareness';
import type { DefaultRpcMap, RpcActionMap } from '../../rpc/types.js';
import { type Actions, isAction } from '../../shared/actions.js';
import type { SharedExtensionContext } from '../../workspace/types.js';
import { broadcastChannelSync } from './broadcast-channel.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Error context from the last failed connection attempt.
 *
 * Discriminated on `type`:
 * - `auth` — Token acquisition failed (`getToken` threw)
 * - `connection` — WebSocket failed to open or dropped
 */
export type SyncError =
	| { type: 'auth'; error: unknown }
	| { type: 'connection' };

/**
 * Connection status of the sync transport.
 *
 * Discriminated on `phase`:
 * - `offline` — Not connected, not trying to connect
 * - `connecting` — Attempting to open a WebSocket or performing handshake.
 *   Carries `attempt` (0 = first, 1+ = reconnecting) and optional `lastError`
 *   from the previous failed attempt.
 * - `connected` — Fully synced and communicating
 */
export type SyncStatus =
	| { phase: 'offline' }
	| { phase: 'connecting'; attempt: number; lastError?: SyncError }
	| { phase: 'connected'; hasLocalChanges: boolean };

/**
 * Sync extension configuration.
 *
 * Supports two auth modes:
 * - **Open**: Just `url` — no auth (localhost, Tailscale, LAN)
 * - **Authenticated**: `url` + `getToken` — dynamic token refresh
 *
 * The `url` callback receives the Y.Doc's GUID (workspace GUID for workspace scope,
 * content doc GUID for document scope). The URL must use the WebSocket protocol
 * (`ws:` or `wss:`).
 *
 * Chain last in the extension chain. Persistence loads local state first,
 * then WebSocket connects for cross-device sync. BroadcastChannel cross-tab
 * sync is included automatically—no separate extension needed.
 *
 * @example
 * ```typescript
 * import { createSyncExtension } from '@epicenter/workspace/extensions/sync/websocket';
 *
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', createSyncExtension({
 *     url: (docId) => `ws://localhost:3913/rooms/${docId}`,
 *   }))
 * ```
 */
export type SyncExtensionConfig = {
	/**
	 * WebSocket URL for the room. Receives the Y.Doc's GUID.
	 *
	 * At workspace scope, this is the workspace ID. At document scope,
	 * this is the content Y.Doc's GUID (unique per document).
	 *
	 * Must use `ws:` or `wss:` protocol. Use {@link toWsUrl} to convert
	 * an HTTP URL if your server config provides one.
	 */
	url: (docId: string) => string;

	/**
	 * Token fetcher for authenticated mode. Called on each connect/reconnect.
	 * The same token is used for both WebSocket (`?token=` query param) and
	 * HTTP snapshot (`Authorization: Bearer` header).
	 */
	getToken?: (docId: string) => Promise<string | null>;
};

/** Exports available on `client.extensions.sync` after registration. */
export type SyncExtensionExports = {
	/** Current connection status. */
	readonly status: SyncStatus;
	/** Subscribe to status changes. Returns unsubscribe function. */
	onStatusChange(listener: (status: SyncStatus) => void): () => void;
	/**
	 * Force a fresh connection with new credentials.
	 *
	 * The supervisor loop restarts its current iteration with a fresh
	 * `getToken()` call—no disconnect/connect race condition.
	 */
	reconnect(): void;

	/**
	 * Invoke an action on a remote peer in this room.
	 *
	 * Pass a type map (from `InferRpcMap`) for full type safety, or omit it
	 * for untyped calls. When typed, action names autocomplete, input is
	 * type-checked, and output is inferred.
	 *
	 * @example Typed (recommended when target app is in the same monorepo)
	 * ```typescript
	 * import type { TabManagerRpc } from '@epicenter/tab-manager/rpc';
	 *
	 * const { data, error } = await workspace.extensions.sync.rpc<TabManagerRpc>(
	 *   peer.clientId, 'tabs.close', { tabIds: [1, 2, 3] },
	 * );
	 * // data is { closedCount: number } | null — inferred from the map
	 * ```
	 *
	 * @example Untyped (when target's types aren't available)
	 * ```typescript
	 * const { data, error } = await workspace.extensions.sync.rpc(
	 *   peer.clientId, 'tabs.close', { tabIds: [1, 2, 3] },
	 * );
	 * // data is unknown
	 * ```
	 *
	 * @param target - Awareness clientId of the target peer
	 * @param action - Dot-path action name (e.g. 'tabs.close')
	 * @param input - Action input (serialized as JSON)
	 * @param options - Optional timeout override (default 5000ms)
	 */
	rpc<
		TMap extends RpcActionMap = DefaultRpcMap,
		TAction extends string & keyof TMap = string & keyof TMap,
	>(
		target: number,
		action: TAction,
		input?: TMap[TAction]['input'],
		options?: { timeout?: number },
	): Promise<Result<TMap[TAction]['output'], RpcError>>;

	/**
	 * Register workspace actions so this peer can handle inbound RPC requests.
	 *
	 * Called automatically by `withActions()` during workspace construction.
	 * Without this, the peer can send RPCs but will silently drop incoming
	 * requests (the caller sees a timeout).
	 */
	registerActions(actions: Actions): void;
};

// ============================================================================
// Constants
// ============================================================================

/** Origin sentinel for sync updates — used to skip echoing remote changes back. */
const SYNC_ORIGIN = Symbol('sync-transport');

const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 30_000;
const LIVENESS_TIMEOUT_MS = 45_000;
const LIVENESS_CHECK_INTERVAL_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;

// ============================================================================
// Public API
// ============================================================================

/**
 * Convert an HTTP(S) URL to its WebSocket equivalent.
 *
 * @example
 * ```typescript
 * createSyncExtension({
 *   url: (id) => toWsUrl(`${APP_URLS.API}/workspaces/${id}`),
 * })
 * // 'http://localhost:8787/...' → 'ws://localhost:8787/...'
 * // 'https://api.epicenter.so/...' → 'wss://api.epicenter.so/...'
 * ```
 */
export function toWsUrl(httpUrl: string): string {
	return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

/**
 * Creates a sync extension that connects a Y.Doc to a WebSocket sync server.
 *
 * Handles Y.Doc sync, awareness, liveness detection, reconnection with
 * exponential backoff, and RPC between peers. Waits for prior extensions
 * (`whenReady`) before connecting, so local state is loaded first.
 *
 * Automatically includes BroadcastChannel cross-tab sync so multiple tabs
 * converge instantly without waiting for the server round-trip. BroadcastChannel
 * no-ops gracefully when unavailable (Node.js, SSR, older browsers).
 *
 * Uses a supervisor loop architecture where one loop owns all status transitions
 * and reconnection logic. Event handlers are reporters only—they resolve
 * promises that the loop awaits, but never make reconnection decisions.
 *
 * Uses V2 encoding for all sync payloads (~40% smaller than V1).
 */
export function createSyncExtension(config: SyncExtensionConfig): (
	context: SharedExtensionContext,
) => SyncExtensionExports & {
	whenReady: Promise<unknown>;
	dispose: () => void;
} {
	return ({ ydoc: doc, awareness: ctxAwareness, whenReady: priorReady }) => {
		const docId = doc.guid;
		const getToken = config.getToken
			? () => config.getToken!(docId)
			: undefined;

		const awareness = ctxAwareness.raw;

		// BroadcastChannel cross-tab sync — instant convergence between same-origin tabs.
		// Runs independently of WebSocket. No-ops when BroadcastChannel is unavailable.
		const bc = broadcastChannelSync({ ydoc: doc });

		// ── Zone 2: Mutable state ──

		const status = createStatusEmitter<SyncStatus>({ phase: 'offline' });
		const backoff = createBackoff();

		/** User intent: should we be connected? Set by connect()/goOffline(). */
		let desired: 'online' | 'offline' = 'offline';

		/**
		 * Monotonic counter bumped by goOffline() and reconnect(). The supervisor
		 * loop captures this at the top of each iteration and `continue`s when
		 * the snapshot no longer matches—restarting with a fresh token.
		 */
		let runId = 0;

		/** Current WebSocket instance, or null. */
		let websocket: WebSocket | null = null;

		// SYNC_STATUS version tracking
		let localVersion = 0;
		let ackedVersion = 0;
		let syncStatusTimer: ReturnType<typeof setTimeout> | null = null;

		// RPC state
		const pendingRequests = new Map<
			number,
			{
				action: string;
				resolve: (result: { data: unknown; error: unknown }) => void;
				timer: ReturnType<typeof setTimeout>;
			}
		>();
		let nextRequestId = 0;

		/** Registered actions for inbound RPC dispatch. Set via `registerActions()`. */
		let registeredActions: Actions | undefined;

		// ── Zone 3: Private helpers ──

		/** Send a binary message if the WebSocket is open; silently no-ops otherwise. */
		function send(message: Uint8Array) {
			if (websocket?.readyState === WebSocket.OPEN) {
				websocket.send(message);
			}
		}

		/** Resolve all pending RPC requests with a Disconnected error and clear state. */
		function clearPendingRequests() {
			const { error } = RpcError.Disconnected();
			for (const [, pending] of pendingRequests) {
				clearTimeout(pending.timer);
				pending.resolve({ data: null, error });
			}
			pendingRequests.clear();
			nextRequestId = 0;
		}

		/**
		 * Handle an inbound RPC request: find the action by dot-path, call it,
		 * and send the response back to the requester.
		 */
		async function handleRpcRequest(rpc: {
			requestId: number;
			requesterClientId: number;
			action: string;
			input: unknown;
		}) {
			const sendResponse = (result: { data: unknown; error: unknown }) =>
				send(
					encodeRpcResponse({
						requestId: rpc.requestId,
						requesterClientId: rpc.requesterClientId,
						result,
					}),
				);

			if (!registeredActions) {
				sendResponse({
					data: null,
					error: RpcError.ActionNotFound({ action: rpc.action }).error,
				});
				return;
			}

			// Walk the action tree by dot-path
			const segments = rpc.action.split('.');
			let target: unknown = registeredActions;
			for (const segment of segments) {
				if (target == null || typeof target !== 'object') {
					target = undefined;
					break;
				}
				target = (target as Record<string, unknown>)[segment];
			}

			if (!isAction(target)) {
				sendResponse({
					data: null,
					error: RpcError.ActionNotFound({ action: rpc.action }).error,
				});
				return;
			}

			const { data, error } = await tryAsync({
				try: () => target(rpc.input),
				catch: (err) =>
					RpcError.ActionFailed({ action: rpc.action, cause: err }),
			});

			if (error) {
				sendResponse({ data: null, error });
				return;
			}
			sendResponse({ data, error: null });
		}

		/** Shared teardown: set offline, bump runId, close socket, remove window listeners. */
		function goOffline() {
			desired = 'offline';
			runId++;
			backoff.wake();
			manageWindowListeners('remove');
			websocket?.close();
			status.set({ phase: 'offline' });
		}

		// ── Doc + awareness handlers ──

		/**
		 * Y.Doc `'updateV2'` handler — broadcasts local mutations to the server.
		 * Skips remote updates (origin === SYNC_ORIGIN) to avoid echoing.
		 */
		function handleDocUpdate(update: Uint8Array, origin: unknown) {
			if (origin === SYNC_ORIGIN) return;
			send(encodeSyncUpdate({ update }));
			localVersion++;
			// Debounce: send probe after 100ms quiet period, not per-update.
			if (syncStatusTimer) clearTimeout(syncStatusTimer);
			syncStatusTimer = setTimeout(() => {
				send(encodeSyncStatus(localVersion));
				syncStatusTimer = null;
			}, 100);
		}

		/**
		 * Awareness `'update'` handler — broadcasts local presence changes
		 * (cursor position, user name, selection, etc.) to all connected peers.
		 */
		function handleAwarenessUpdate({
			added,
			updated,
			removed,
		}: {
			added: number[];
			updated: number[];
			removed: number[];
		}) {
			const changedClients = added.concat(updated).concat(removed);
			send(
				encodeAwareness({
					update: encodeAwarenessUpdate(awareness, changedClients),
				}),
			);
		}

		// ── Browser event handlers ──

		function handleOnline() {
			backoff.wake();
		}

		function handleOffline() {
			websocket?.close();
		}

		function handleVisibilityChange() {
			if (document.visibilityState !== 'visible') return;
			if (websocket?.readyState === WebSocket.OPEN) {
				websocket.send('ping');
			}
		}

		function manageWindowListeners(action: 'add' | 'remove') {
			const method =
				action === 'add' ? 'addEventListener' : 'removeEventListener';
			if (typeof window !== 'undefined') {
				window[method]('offline', handleOffline);
				window[method]('online', handleOnline);
			}
			if (typeof document !== 'undefined') {
				document[method]('visibilitychange', handleVisibilityChange);
			}
		}

		// ── Supervisor loop ──

		/**
		 * The supervisor loop is the SINGLE OWNER of status transitions,
		 * reconnection decisions, and socket lifecycle. Event handlers only
		 * resolve promises—they never call connect() or set status.
		 *
		 * Single `while` loop. Calls `getToken()` fresh on each iteration.
		 * reconnect() bumps `runId` to restart the current iteration.
		 */
		async function runLoop() {
			let attempt = 0;
			let lastError: SyncError | undefined;

			while (desired === 'online') {
				const myRunId = runId;

				// Pending RPCs from the previous connection will never resolve—
				// clear them before starting a new attempt.
				clearPendingRequests();

				status.set({ phase: 'connecting', attempt, lastError });

				// --- Token acquisition (fresh each iteration) ---
				let token: string | null = null;
				if (getToken) {
					try {
						token = await getToken();
						if (!token) throw new Error('No token available');
					} catch (e) {
						if (runId !== myRunId) {
							attempt = 0;
							lastError = undefined;
							continue;
						}
						console.warn('[SyncExtension] Failed to get token', e);
						lastError = { type: 'auth', error: e };
						status.set({ phase: 'connecting', attempt, lastError });
						await backoff.sleep();
						if (runId !== myRunId) {
							attempt = 0;
							lastError = undefined;
							continue;
						}
						attempt += 1;
						continue;
					}
				}

				if (runId !== myRunId) {
					attempt = 0;
					lastError = undefined;
					continue;
				}

				// --- Single connection attempt ---
				const result = await attemptConnection(token, myRunId);

				if (runId !== myRunId) {
					attempt = 0;
					lastError = undefined;
					continue;
				}

				if (result === 'connected') {
					backoff.reset();
					lastError = undefined;
				} else {
					lastError = { type: 'connection' };
				}

				// Backoff before retry
				if (desired === 'online') {
					attempt += 1;
					status.set({ phase: 'connecting', attempt, lastError });
					await backoff.sleep();
					if (runId !== myRunId) {
						attempt = 0;
						lastError = undefined;
					}
				}
			}

			status.set({ phase: 'offline' });
		}

		/**
		 * Attempt a single WebSocket connection. Returns when the socket closes.
		 *
		 * @returns 'connected' if the handshake completed and we ran until close,
		 *          'failed' if the connection failed before handshake,
		 *          'cancelled' if runId changed during the attempt.
		 */
		async function attemptConnection(
			token: string | null,
			myRunId: number,
		): Promise<'connected' | 'failed' | 'cancelled'> {
			let wsUrl = config.url(docId);
			if (token) {
				const parsed = new URL(wsUrl);
				parsed.searchParams.set('token', token);
				wsUrl = parsed.toString();
			}

			const ws = new WebSocket(wsUrl);
			ws.binaryType = 'arraybuffer';
			websocket = ws;

			// Reset SYNC_STATUS counters for fresh connection
			localVersion = 0;
			ackedVersion = 0;
			if (syncStatusTimer) {
				clearTimeout(syncStatusTimer);
				syncStatusTimer = null;
			}

			const { promise: openPromise, resolve: resolveOpen } =
				Promise.withResolvers<boolean>();
			const { promise: closePromise, resolve: resolveClose } =
				Promise.withResolvers<void>();
			let handshakeComplete = false;

			const liveness = createLivenessMonitor(ws);

			const connectTimeout = setTimeout(() => {
				if (ws.readyState === WebSocket.CONNECTING) ws.close();
			}, CONNECT_TIMEOUT_MS);

			ws.onopen = () => {
				clearTimeout(connectTimeout);
				send(encodeSyncStep1({ doc }));

				if (awareness.getLocalState() !== null) {
					send(
						encodeAwarenessStates({
							awareness,
							clients: [doc.clientID],
						}),
					);
				}

				liveness.start();
				resolveOpen(true);
			};

			ws.onclose = () => {
				clearTimeout(connectTimeout);
				liveness.stop();

				removeAwarenessStates(
					awareness,
					Array.from(awareness.getStates().keys()).filter(
						(client) => client !== doc.clientID,
					),
					SYNC_ORIGIN,
				);

				websocket = null;
				resolveOpen(false);
				resolveClose();
			};

			ws.onerror = () => {
				resolveOpen(false);
			};

			ws.onmessage = (event: MessageEvent) => {
				liveness.touch();

				if (typeof event.data === 'string') return;

				const data: Uint8Array = new Uint8Array(event.data);
				const decoder = decoding.createDecoder(data);
				const messageType = decoding.readVarUint(decoder);

				switch (messageType) {
					case MESSAGE_TYPE.SYNC: {
						const syncType = decoding.readVarUint(decoder) as SyncMessageType;
						const payload = decoding.readVarUint8Array(decoder);
						const response = handleSyncPayload({
							syncType,
							payload,
							doc,
							origin: SYNC_ORIGIN,
						});
						if (response) {
							send(response);
						} else if (
							!handshakeComplete &&
							(syncType === SYNC_MESSAGE_TYPE.STEP2 ||
								syncType === SYNC_MESSAGE_TYPE.UPDATE)
						) {
							handshakeComplete = true;
							status.set({
								phase: 'connected',
								hasLocalChanges: localVersion > ackedVersion,
							});
						}
						break;
					}

					case MESSAGE_TYPE.AWARENESS: {
						applyAwarenessUpdate(
							awareness,
							decoding.readVarUint8Array(decoder),
							SYNC_ORIGIN,
						);
						break;
					}

					case MESSAGE_TYPE.QUERY_AWARENESS: {
						send(
							encodeAwarenessStates({
								awareness,
								clients: Array.from(awareness.getStates().keys()),
							}),
						);
						break;
					}

					case MESSAGE_TYPE.SYNC_STATUS: {
						const version = decoding.readVarUint(decoder);
						const prevHasChanges = localVersion > ackedVersion;
						ackedVersion = Math.max(ackedVersion, version);
						const nowHasChanges = localVersion > ackedVersion;
						if (prevHasChanges !== nowHasChanges && handshakeComplete) {
							status.set({
								phase: 'connected',
								hasLocalChanges: nowHasChanges,
							});
						}
						break;
					}

					case MESSAGE_TYPE.RPC: {
						const rpc = decodeRpcPayload(decoder);
						if (rpc.type === 'response') {
							const pending = pendingRequests.get(rpc.requestId);
							if (pending) {
								clearTimeout(pending.timer);
								pendingRequests.delete(rpc.requestId);
								pending.resolve(rpc.result);
							}
						} else if (rpc.type === 'request') {
							void handleRpcRequest(rpc);
						}
						break;
					}

					default:
						console.warn(
							`[SyncExtension] Unknown message type: ${messageType}`,
						);
						break;
				}
			};

			// --- Wait for open or failure ---
			const opened = await openPromise;
			if (!opened || runId !== myRunId) {
				if (
					ws.readyState !== WebSocket.CLOSED &&
					ws.readyState !== WebSocket.CLOSING
				) {
					ws.close();
				}
				await closePromise;
				return runId !== myRunId ? 'cancelled' : 'failed';
			}

			await closePromise;
			return handshakeComplete ? 'connected' : 'failed';
		}

		// ── Attach listeners + start ──

		doc.on('updateV2', handleDocUpdate);
		awareness.on('update', handleAwarenessUpdate);

		const whenReady = (async () => {
			await priorReady;
			desired = 'online';
			manageWindowListeners('add');
			runLoop();
		})();

		// ── Zone 4: Public API ──

		return {
			get status() {
				return status.get();
			},

			onStatusChange: status.subscribe,

			reconnect() {
				if (desired !== 'online') return;
				runId++;
				backoff.reset();
				backoff.wake();
				websocket?.close();
			},

			registerActions(actions: Actions) {
				registeredActions = actions;
			},

			async rpc<
				TMap extends RpcActionMap = DefaultRpcMap,
				TAction extends string & keyof TMap = string & keyof TMap,
			>(
				target: number,
				action: TAction,
				input?: TMap[TAction]['input'],
				options?: { timeout?: number },
			): Promise<Result<TMap[TAction]['output'], RpcError>> {
				if (target === doc.clientID) {
					return RpcError.ActionFailed({
						action,
						cause: 'Cannot RPC to self — call the action directly',
					});
				}

				const timeoutMs = options?.timeout ?? DEFAULT_RPC_TIMEOUT_MS;

				return new Promise((resolve) => {
					const requestId = nextRequestId++;
					send(
						encodeRpcRequest({
							requestId,
							targetClientId: target,
							requesterClientId: doc.clientID,
							action,
							input,
						}),
					);

					const timer = setTimeout(() => {
						pendingRequests.delete(requestId);
						resolve(RpcError.Timeout({ ms: timeoutMs }));
					}, timeoutMs);

					pendingRequests.set(requestId, {
						action,
						resolve: (result) => {
							clearTimeout(timer);
							if (isRpcError(result.error)) {
								resolve({ data: null, error: result.error });
							} else if (result.error != null) {
								resolve(
									RpcError.ActionFailed({
										action,
										cause: result.error,
									}),
								);
							} else {
								// Trust-the-wire cast: both RPC sides are in the same monorepo.
								// Same pattern as tRPC/Eden Treaty — structural type safety, not
								// runtime. Unavoidable without output schemas on actions.
								resolve({
									data: result.data as TMap[TAction]['output'],
									error: null,
								});
							}
						},
						timer,
					});
				});
			},

			whenReady,

			dispose() {
				clearPendingRequests();
				if (syncStatusTimer) {
					clearTimeout(syncStatusTimer);
					syncStatusTimer = null;
				}
				goOffline();
				doc.off('updateV2', handleDocUpdate);
				awareness.off('update', handleAwarenessUpdate);
				bc.dispose?.();
				status.clear();
			},
		};
	};
}

// ============================================================================
// Helpers (module-level — genuinely reusable state machines)
// ============================================================================

/**
 * Creates a status emitter. Encapsulates a value + listener set.
 * Every `set()` notifies listeners — no dedup (SyncStatus is an object).
 */
function createStatusEmitter<T>(initial: T) {
	let current = initial;
	const listeners = new Set<(value: T) => void>();

	return {
		get() {
			return current;
		},
		set(value: T) {
			current = value;
			for (const listener of listeners) {
				listener(value);
			}
		},
		subscribe(listener: (value: T) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		clear() {
			listeners.clear();
		},
	};
}

/**
 * Creates a liveness monitor that detects dead WebSocket connections.
 * Sends periodic pings and closes the socket if no messages arrive.
 */
function createLivenessMonitor(ws: WebSocket) {
	let pingInterval: ReturnType<typeof setInterval> | null = null;
	let livenessInterval: ReturnType<typeof setInterval> | null = null;
	let lastMessageTime = 0;

	function stop() {
		if (pingInterval) clearInterval(pingInterval);
		if (livenessInterval) clearInterval(livenessInterval);
	}

	return {
		start() {
			stop();
			lastMessageTime = Date.now();

			pingInterval = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) ws.send('ping');
			}, PING_INTERVAL_MS);

			livenessInterval = setInterval(() => {
				if (Date.now() - lastMessageTime > LIVENESS_TIMEOUT_MS) {
					ws.close();
				}
			}, LIVENESS_CHECK_INTERVAL_MS);
		},
		touch() {
			lastMessageTime = Date.now();
		},
		stop,
	};
}

/**
 * Creates a backoff controller with exponential delay, jitter, and a wakeable sleeper.
 */
function createBackoff() {
	let retries = 0;
	let sleeper: { promise: Promise<void>; wake(): void } | null = null;

	return {
		async sleep() {
			const exponential = Math.min(BASE_DELAY_MS * 2 ** retries, MAX_DELAY_MS);
			const ms = exponential * (0.5 + Math.random() * 0.5);
			retries += 1;

			const { promise, resolve } = Promise.withResolvers<void>();
			const handle = setTimeout(resolve, ms);
			sleeper = {
				promise,
				wake() {
					clearTimeout(handle);
					resolve();
				},
			};
			await promise;
			sleeper = null;
		},
		wake() {
			sleeper?.wake();
		},
		reset() {
			retries = 0;
		},
	};
}
