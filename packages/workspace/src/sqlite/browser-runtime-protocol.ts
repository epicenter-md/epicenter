import type { SqliteValue } from '@epicenter/sqlite';
import type { TSchema } from 'typebox';
import type { LogicalWorkspaceCopy } from './canonical-addition.js';
import type {
	WorkspaceSyncSettlement,
	WorkspaceSyncStatus,
} from './canonical-sync-supervisor.js';
import type { TableLensDefinitions } from './lens-definition.js';

export type SerializedTableLens = {
	fields: Record<string, TSchema>;
	optional: string[];
};

export type BrowserWorkspaceManifest = {
	workspaceId: string;
	storageKey: string;
	tables: Record<string, SerializedTableLens>;
	/** Serialized field.* schemas for this release's KV lens (ADR-0132). */
	kv: Record<string, unknown>;
	rowSync?: BrowserRowSyncBinding;
};

/** Serializable environment binding consumed only inside the records Worker. */
export type BrowserRowSyncBinding = {
	intervalMs: number;
};

export type BrowserRecordOperation =
	| { kind: 'open' }
	| { kind: 'get'; table: string; id: string }
	| { kind: 'kv-get'; key: string }
	| { kind: 'kv-set'; key: string; value: unknown }
	| { kind: 'kv-unset'; key: string }
	| { kind: 'read-current-row'; table: string; rowId: string }
	| { kind: 'sync-settle' }
	| { kind: 'sync-capture-recovery' }
	| { kind: 'sync-start-fresh' }
	| { kind: 'logical-capture' }
	| { kind: 'capture-visible' }
	| { kind: 'capture-confirmed' }
	| { kind: 'logical-add'; copy: LogicalWorkspaceCopy }
	| { kind: 'logical-delete' }
	| { kind: 'list'; table: string }
	| { kind: 'create'; table: string; input: Record<string, unknown> }
	| {
			kind: 'update';
			table: string;
			id: string;
			changes: Record<string, unknown>;
	  }
	| { kind: 'delete'; table: string; id: string }
	| {
			kind: 'sql';
			query: string;
			parameters: readonly SqliteValue[];
			resultSchema: TSchema;
	  };

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

/** Copy release-local lenses into values that can cross a Worker boundary. */
export function serializeTableLenses(
	definitions: TableLensDefinitions,
): Record<string, SerializedTableLens> {
	return Object.fromEntries(
		Object.entries(definitions).map(([name, definition]) => [
			name,
			{
				fields: structuredClone(definition.fields),
				optional: [...definition.optional],
			},
		]),
	);
}
