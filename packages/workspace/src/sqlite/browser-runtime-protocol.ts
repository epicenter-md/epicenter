import type { SqliteValue } from '@epicenter/row-sync';
import type { TSchema } from 'typebox';
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
	recordSync?: BrowserRecordSyncBinding;
};

/** Serializable environment binding consumed only inside the records Worker. */
export type BrowserRecordSyncBinding = {
	intervalMs: number;
};

export type BrowserRecordOperation =
	| { kind: 'get'; table: string; id: string }
	| { kind: 'kv-get'; key: string }
	| { kind: 'kv-set'; key: string; value: unknown }
	| { kind: 'kv-unset'; key: string }
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
	  };

export type BrowserWorkerInbound =
	| BrowserRuntimeRequest
	| BrowserTransportResponse;

export type BrowserRuntimeMessage =
	| { type: 'ready' }
	| { type: 'records-changed'; workspaceId: string }
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
			action: 'sync' | 'enroll' | 'baseline-scan';
			body: unknown;
	  }
	| { type: 'result'; id: number; value: unknown }
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
