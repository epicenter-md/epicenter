import type { SqliteValue } from '@epicenter/record-sync';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { isResult, Ok, type Result } from 'wellcrafted/result';

export const DESKTOP_WORKSPACE_ROUTE = '/api/workspaces/:workspaceId/records';
export const DESKTOP_DOCUMENT_ROUTE =
	'/api/workspaces/:workspaceId/documents/:declaration/open';

export type DesktopRecordOperation =
	| { kind: 'get'; table: string; id: string }
	| {
			kind: 'scan';
			table: string;
			options: { cursor?: string; limit: number };
	  }
	| { kind: 'create'; table: string; input: Record<string, unknown> }
	| {
			kind: 'patch';
			table: string;
			id: string;
			set: Record<string, unknown>;
			unset: string[];
	  }
	| { kind: 'delete'; table: string; id: string }
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

/** Preserve optional row Results across JSON, which cannot encode undefined. */
export function encodeDesktopRecordResult(
	operation: DesktopRecordOperation,
	result: unknown,
): unknown {
	if (
		isOptionalRowOperation(operation) &&
		isResult(result) &&
		result.error === null &&
		result.data === undefined
	) {
		return Ok(null);
	}
	return result;
}

/** Restore the public undefined absence value from its wire-only null. */
export function decodeDesktopRecordResult(
	operation: DesktopRecordOperation,
	result: unknown,
): unknown {
	if (
		isOptionalRowOperation(operation) &&
		isResult(result) &&
		result.error === null &&
		result.data === null
	) {
		return Ok(undefined);
	}
	return result;
}

function isOptionalRowOperation(operation: DesktopRecordOperation): boolean {
	return operation.kind === 'get' || operation.kind === 'patch';
}

export function desktopWorkspaceRecordUrl(
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

export function desktopDocumentOpenUrl(
	baseUrl: string,
	workspaceId: string,
	declaration: string,
): string {
	return new URL(
		DESKTOP_DOCUMENT_ROUTE.replace(
			':workspaceId',
			encodeURIComponent(workspaceId),
		).replace(':declaration', encodeURIComponent(declaration)),
		baseUrl,
	).toString();
}
