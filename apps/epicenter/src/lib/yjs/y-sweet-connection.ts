import { createYjsProvider, type YSweetProvider } from '@y-sweet/client';
import * as Y from 'yjs';

type YSweetConnectionConfig = {
	/** Workspace ID (used as Y.Doc guid and room name) */
	workspaceId: string;
	/** Y-Sweet server base URL (e.g., 'http://127.0.0.1:8080') */
	serverUrl: string;
};

type YSweetConnection = {
	ydoc: Y.Doc;
	provider: YSweetProvider;
	whenSynced: Promise<void>;
	destroy: () => void;
};

/**
 * Create a Y.Doc connected to a Y-Sweet server
 * Uses direct mode (no authentication)
 */
export function createYSweetConnection(
	config: YSweetConnectionConfig,
): YSweetConnection {
	const { workspaceId, serverUrl } = config;

	// Create Y.Doc with workspace ID as guid
	const ydoc = new Y.Doc({ guid: workspaceId });

	// Create provider with direct connection info
	const provider = createYjsProvider(ydoc, workspaceId, async () => ({
		url: `${serverUrl.replace('http', 'ws')}/d/${workspaceId}/ws`,
		baseUrl: serverUrl,
		docId: workspaceId,
		token: undefined, // No auth in direct mode
	}));

	// Create sync promise
	const whenSynced = new Promise<void>((resolve) => {
		if (provider.synced) {
			resolve();
		} else {
			const handleSync = (synced: boolean) => {
				if (synced) {
					provider.off('sync', handleSync);
					resolve();
				}
			};
			provider.on('sync', handleSync);
		}
	});

	const destroy = () => {
		provider.destroy();
		ydoc.destroy();
	};

	return { ydoc, provider, whenSynced, destroy };
}

/**
 * Get the default Y-Sweet server URL from app settings
 * Falls back to localhost:8080 if not configured
 */
export function getDefaultSyncUrl(): string {
	// TODO: Read from app settings store
	return 'http://127.0.0.1:8080';
}
