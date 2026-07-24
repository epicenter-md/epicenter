import type { WireRowIntent } from '@epicenter/row-sync';
import type { LogicalWorkspaceCopy } from './canonical-addition.js';
import type {
	WorkspaceSyncSettlement,
	WorkspaceSyncStatus,
} from './canonical-sync-supervisor.js';

/**
 * Error name the records Worker stamps when a newer tab steals this
 * workspace's storage (newest tab wins). It reaches the page twice: once
 * through `onBackgroundError` at the moment of the steal, and again on every
 * later operation, which fails with the same named error.
 */
export const WORKSPACE_STORAGE_MOVED_ERROR_NAME = 'WorkspaceStorageMovedError';

/**
 * True when an error means this tab's workspace storage moved to a newer
 * tab. Apps use this in `onBackgroundError` to flip their one blocking
 * "moved" state instead of leaving a stale-live UI behind.
 */
export function isWorkspaceStorageMovedError(cause: unknown): boolean {
	return (
		cause instanceof Error && cause.name === WORKSPACE_STORAGE_MOVED_ERROR_NAME
	);
}

/**
 * Error name the records Worker stamps when it cannot acquire this
 * workspace's storage because another context still holds it: a suspended
 * tab or backgrounded PWA that retains the OPFS access handles while unable
 * to answer the steal notification. `runtime.open()` rejects with this
 * named error; the recovery is closing or resuming the other surface, then
 * retrying.
 */
export const WORKSPACE_STORAGE_HELD_ERROR_NAME = 'WorkspaceStorageHeldError';

/**
 * True when an error means workspace storage is held by another context
 * that could not hand it off. Boot gates use this to render one blocking
 * held-storage screen with concrete recovery instructions.
 */
export function isWorkspaceStorageHeldError(cause: unknown): boolean {
	return (
		cause instanceof Error && cause.name === WORKSPACE_STORAGE_HELD_ERROR_NAME
	);
}

export type BrowserWorkspaceManifest = {
	workspaceId: string;
	storageKey: string;
	rowSync?: BrowserRowSyncBinding;
};

/** Serializable environment binding consumed only inside the records Worker. */
export type BrowserRowSyncBinding = {
	intervalMs: number;
};

export type BrowserRecordOperation =
	| { kind: 'open' }
	| { kind: 'read-current-row'; table: string; rowId: string }
	| { kind: 'document-load'; table: string; rowId: string }
	| {
			kind: 'document-append';
			table: string;
			rowId: string;
			update: Uint8Array;
	  }
	| { kind: 'list-current-rows'; table: string }
	| { kind: 'admit-intent'; intent: WireRowIntent }
	| { kind: 'kv-read-map' }
	| { kind: 'sync-settle' }
	| { kind: 'sync-capture-recovery' }
	| { kind: 'sync-start-fresh' }
	| { kind: 'logical-capture' }
	| { kind: 'capture-visible' }
	| { kind: 'logical-add'; copy: LogicalWorkspaceCopy }
	| { kind: 'logical-delete' };

export type BrowserRuntimeRequest = {
	id: number;
	manifest: BrowserWorkspaceManifest;
	operation: BrowserRecordOperation;
};

export type BrowserTransportResponse =
	| { type: 'transport-result'; transportId: number; value: unknown }
	| {
			type: 'transport-error';
			transportId: number;
			name: string;
			message: string;
			pendingReason?:
				| 'offline'
				| 'retrying'
				| 'authentication'
				| 'storage-limit';
	  };

export type BrowserWorkerInbound =
	| BrowserRuntimeRequest
	| BrowserTransportResponse;

export type BrowserRuntimeMessage =
	| { type: 'ready' }
	| { type: 'records-changed'; workspaceId: string }
	| {
			type: 'rows-deleted';
			workspaceId: string;
			addresses: { table: string; rowId: string }[];
	  }
	| {
			type: 'sync-status';
			workspaceId: string;
			status: WorkspaceSyncStatus;
	  }
	| {
			type: 'background-error';
			workspaceId: string;
			name: string;
			message: string;
	  }
	| {
			type: 'transport-request';
			transportId: number;
			workspaceId: string;
			action: 'push' | 'pull' | 'acquire';
			body: unknown;
	  }
	| {
			type: 'result';
			id: number;
			value: unknown | WorkspaceSyncSettlement;
	  }
	| { type: 'error'; id: number; name: string; message: string };
