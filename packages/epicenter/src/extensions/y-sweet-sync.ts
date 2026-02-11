import {
	type AuthEndpoint,
	createYjsProvider,
	type YSweetProvider,
} from '@y-sweet/client';
import type { ClientToken } from '@y-sweet/sdk';
import { defineExports, type ExtensionFactory } from '../dynamic/extension';
import type { KvField, TableDefinition } from '../dynamic/schema';

// ═══════════════════════════════════════════════════════════════════════════════
// Y-SWEET SYNC EXTENSION
// ═══════════════════════════════════════════════════════════════════════════════
//
// Y-Sweet is a hosted/self-hosted Yjs sync and persistence service by Jamsocket.
//
// Two modes:
// - Direct: Connect to Y-Sweet server without auth (local dev, Tailscale)
// - Authenticated: Connect via backend auth endpoint (hosted infrastructure)
//
// Server setup (local development):
//   npx y-sweet@latest serve           # In-memory storage
//   npx y-sweet@latest serve ./data    # Persisted to disk
//
// Server runs at http://127.0.0.1:8080 by default.
// WebSocket URL format: ws://{host}/d/{docId}/ws
//
// Spec: specs/y-sweet-sync-extension.md
//
// ═══════════════════════════════════════════════════════════════════════════════

// Re-export the ClientToken type for consumers
export type { ClientToken as YSweetClientToken };

/**
 * Direct mode configuration.
 *
 * Connect directly to a Y-Sweet server without authentication.
 * Use for local development or private networks (Tailscale).
 */
export type YSweetDirectConfig = {
	mode: 'direct';
	/**
	 * Y-Sweet server URL.
	 *
	 * @example 'http://localhost:8080'
	 * @example 'http://my-server.tailnet:8080'
	 */
	serverUrl: string;
};

/**
 * Authenticated mode configuration.
 *
 * Connect via your backend's auth endpoint to get a ClientToken.
 * The backend validates the user and namespaces the doc ID.
 *
 * Auth flow: specs/y-sweet-sync-extension.md
 * Implementation: specs/extension-authentication.md (TODO)
 */
export type YSweetAuthenticatedConfig = {
	mode: 'authenticated';
	/**
	 * Auth endpoint that returns a ClientToken.
	 *
	 * @example String URL (extension POSTs to get token)
	 * ```typescript
	 * authEndpoint: 'https://api.epicenter.app/y-sweet/auth'
	 * ```
	 *
	 * @example Async function (custom auth logic)
	 * ```typescript
	 * authEndpoint: async () => {
	 *   const token = await getStoredAuthToken();
	 *   const res = await fetch('https://api.epicenter.app/y-sweet/auth', {
	 *     method: 'POST',
	 *     headers: { Authorization: `Bearer ${token}` },
	 *     body: JSON.stringify({ docId: 'tab-manager' }),
	 *   });
	 *   return res.json();
	 * }
	 * ```
	 */
	authEndpoint: string | (() => Promise<ClientToken>);
};

/**
 * Y-Sweet sync configuration.
 */
export type YSweetSyncConfig = YSweetDirectConfig | YSweetAuthenticatedConfig;

/**
 * Creates a Y-Sweet sync extension.
 *
 * Y-Sweet provides:
 * - WebSocket-based real-time sync
 * - Token-based authentication
 * - Automatic reconnection
 *
 * Note: For offline persistence, use y-indexeddb alongside this extension.
 *
 * ## Direct Mode (local dev, Tailscale)
 *
 * ```typescript
 * sync: ySweetSync({
 *   mode: 'direct',
 *   serverUrl: 'http://localhost:8080',
 * })
 * ```
 *
 * Start local server: `npx y-sweet@latest serve`
 *
 * ## Authenticated Mode (hosted infrastructure)
 *
 * ```typescript
 * sync: ySweetSync({
 *   mode: 'authenticated',
 *   authEndpoint: async () => {
 *     const token = await getStoredAuthToken();
 *     const res = await fetch('https://api.epicenter.app/y-sweet/auth', {
 *       method: 'POST',
 *       headers: { Authorization: `Bearer ${token}` },
 *       body: JSON.stringify({ docId: 'tab-manager' }),
 *     });
 *     return res.json();
 *   },
 * })
 * ```
 *
 * @see specs/y-sweet-sync-extension.md
 */
export function ySweetSync<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
>(config: YSweetSyncConfig): ExtensionFactory<TTableDefinitions, TKvFields> {
	return ({ ydoc }) => {
		const provider: YSweetProvider = createYjsProvider(
			ydoc,
			ydoc.guid,
			buildAuthEndpoint(config, ydoc.guid),
		);

		// Create a promise that resolves when initially synced
		// Use status check instead of deprecated 'synced' property
		const whenSynced = new Promise<void>((resolve) => {
			if (provider.status === 'connected') {
				resolve();
			} else {
				provider.on('sync', () => resolve());
			}
		});

		return defineExports({
			provider,
			whenSynced,
			destroy: () => {
				provider.destroy();
			},
		});
	};
}

/**
 * Build the AuthEndpoint from config.
 *
 * - Direct mode: construct ClientToken locally (no auth)
 * - Authenticated mode: use provided endpoint (string URL or function)
 */
function buildAuthEndpoint(
	config: YSweetSyncConfig,
	docId: string,
): AuthEndpoint {
	switch (config.mode) {
		case 'direct':
			return async () => createDirectClientToken(config.serverUrl, docId);

		case 'authenticated':
			return typeof config.authEndpoint === 'function'
				? config.authEndpoint
				: createAuthFetcher(config.authEndpoint, docId);

		default: {
			const _exhaustive: never = config;
			throw new Error(
				`Unknown Y-Sweet sync mode: ${(_exhaustive as YSweetSyncConfig).mode}`,
			);
		}
	}
}

/**
 * Create an auth fetcher that POSTs to the given URL to get a ClientToken.
 */
function createAuthFetcher(authUrl: string, docId: string): AuthEndpoint {
	return async () => {
		const res = await fetch(authUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ docId }),
		});
		if (!res.ok) {
			throw new Error(`Y-Sweet auth failed: ${res.status} ${res.statusText}`);
		}
		return res.json() as Promise<ClientToken>;
	};
}

/**
 * Construct a ClientToken for direct mode (no auth).
 *
 * Y-Sweet URL format:
 * - WebSocket: ws://{host}/d/{docId}/ws
 * - HTTP: http://{host}/d/{docId}
 */
function createDirectClientToken(
	serverUrl: string,
	docId: string,
): ClientToken {
	const url = new URL(serverUrl);
	const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

	return {
		url: `${wsProtocol}//${url.host}/d/${docId}/ws`,
		baseUrl: `${url.protocol}//${url.host}`,
		docId,
		token: undefined,
	};
}
