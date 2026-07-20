import type {
	BrowserOperation,
	SerializedTableDefinition,
	SerializedValueDefinition,
} from './browser/protocol.js';

export const DESKTOP_EPICENTER_ROUTE = '/api/data';

/**
 * Desktop and browser adapters share the same definition and operation wire
 * vocabulary. Their carrier envelopes differ because the browser uses a
 * MessagePort while the desktop uses authenticated same-origin HTTP.
 */
export type DesktopOperation =
	| Exclude<
			BrowserOperation,
			| { kind: 'attach-sync' }
			| { kind: 'sync-credentials' }
			| { kind: 'document-update' }
	  >
	| { kind: 'document-update'; documentId: number; update: string }
	| { kind: 'document-refresh'; documentId: number };

export type DesktopRequest = {
	surfaceId: string;
	operation: DesktopOperation;
};

export type DesktopResponse =
	| { data: unknown; error: null }
	| { data: null; error: { name: string; message: string } };

export function desktopEpicenterUrl(baseUrl: string): string {
	return new URL(DESKTOP_EPICENTER_ROUTE, baseUrl).toString();
}

export type { SerializedTableDefinition, SerializedValueDefinition };
