import type { WireRowIntent } from '@epicenter/row-sync';
import type { SqliteValue } from '@epicenter/sqlite';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const DESKTOP_WORKSPACE_ROUTE = '/api/workspaces/:workspaceId/records';

export type DesktopRecordOperation =
	/** Acquire the workspace's SQLite owner on the host; the WebView open handshake. */
	| { kind: 'open' }
	| { kind: 'read-current-row'; table: string; rowId: string }
	| { kind: 'list-current-rows'; table: string }
	| { kind: 'admit-intent'; intent: WireRowIntent }
	| { kind: 'kv-read-map' }
	| { kind: 'document-load'; table: string; rowId: string }
	| {
			/** Base64 document-provider transport encoding of one Yjs updateV2. */
			kind: 'document-append';
			table: string;
			rowId: string;
			update: string;
	  }
	| {
			kind: 'sql';
			query: string;
			parameters: readonly SqliteValue[];
	  };

/**
 * One desktop records request: the operation plus the surface identity of the
 * WebView runtime that sent it. Exactly one surface owns a workspace at a
 * time; an `open` from a newer surface displaces the previous owner, whose
 * later requests fail with the named moved error.
 */
export type DesktopRecordRequest = {
	surfaceId: string;
	operation: DesktopRecordOperation;
};

export const DesktopWorkspaceError = defineErrors({
	OwnerUnavailable: () => ({
		message: 'The desktop workspace owner is unavailable.',
	}),
	UnknownWorkspace: ({ workspaceId }: { workspaceId: string }) => ({
		message: `Unknown workspace '${workspaceId}'.`,
		workspaceId,
	}),
	InvalidRequest: ({ cause }: { cause: unknown }) => ({
		message: `The desktop workspace request is invalid: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/**
	 * The variant key deliberately matches the browser runtime's
	 * `WORKSPACE_STORAGE_MOVED_ERROR_NAME`, so one shared guard and one
	 * blocking moved screen serve both carriers.
	 */
	WorkspaceStorageMovedError: ({ workspaceId }: { workspaceId: string }) => ({
		message: `Workspace '${workspaceId}' moved to a newer window.`,
		workspaceId,
	}),
	/** A document append lost its race with scalar row deletion. */
	DocumentRowAbsentError: ({ workspaceId }: { workspaceId: string }) => ({
		message: `The document row in workspace '${workspaceId}' no longer exists.`,
		workspaceId,
	}),
});
export type DesktopWorkspaceError = InferErrors<typeof DesktopWorkspaceError>;

export type DesktopWorkspaceResponse = Result<unknown, DesktopWorkspaceError>;

/** JSON transport encoding for document update bytes on the desktop carrier. */
export function encodeDocumentBytes(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** Decode document update bytes from their JSON transport form. */
export function decodeDocumentBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

export function desktopWorkspaceUrl(
	baseUrl: string,
	workspaceId: string,
): string {
	return new URL(
		DESKTOP_WORKSPACE_ROUTE.replace(
			':workspaceId',
			encodeURIComponent(workspaceId),
		),
		baseUrl,
	).toString();
}
