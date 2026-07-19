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
	| { kind: 'read-current-document'; table: string; rowId: string }
	| {
			kind: 'persist-document-update';
			table: string;
			rowId: string;
			update: string;
	  }
	| {
			kind: 'sql';
			query: string;
			parameters: readonly SqliteValue[];
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
});
export type DesktopWorkspaceError = InferErrors<typeof DesktopWorkspaceError>;

export type DesktopWorkspaceResponse = Result<unknown, DesktopWorkspaceError>;

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
