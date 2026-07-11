/** Gate 1-2 protocol: one exact schema epoch and one database incarnation. */

export type RequestEnvelope = {
	protocolMajor: number;
	schemaEpochId: string;
	databaseIncarnationId: string;
};

export const ENVELOPE = {
	protocolMajor: 1,
	schemaEpochId: 'gate1-notes-v1',
	databaseIncarnationId: 'gate1-database-1',
} as const satisfies RequestEnvelope;

export type JsonCell = string | number | boolean | null;
export type Cells = Record<string, JsonCell>;

export type Operation =
	| { kind: 'patchRow'; table: string; rowId: string; cells: Cells }
	| { kind: 'deleteRow'; table: string; rowId: string };

/** Actor identity plus its contiguous sequence is the mutation identity. */
export type Mutation = {
	actorId: string;
	actorSequence: number;
	operations: Operation[];
};

export type LoggedMutation = Mutation & { serverSequence: number };

export type SnapshotRow = {
	table: string;
	rowId: string;
	deleted: boolean;
	cells: Cells;
};

export type SnapshotManifestBody = {
	generation: number;
	snapshotSequence: number;
	chunkChecksums: string[];
	actorHighWater: Record<string, number>;
};
export type SnapshotManifest = SnapshotManifestBody & { checksum: string };
export type SnapshotChunk = {
	generation: number;
	index: number;
	rows: SnapshotRow[];
	checksum: string;
};

export type PushRequest = RequestEnvelope & {
	kind: 'push';
	mutations: Mutation[];
};
export type PullRequest = RequestEnvelope & {
	kind: 'pull';
	cursor: number;
	limit: number;
};
export type SnapshotChunkRequest = RequestEnvelope & {
	kind: 'snapshotChunk';
	generation: number;
	index: number;
};

export type Refusal =
	| 'protocol-mismatch'
	| 'schema-epoch-mismatch'
	| 'database-incarnation-mismatch';

export type PushResponse =
	| { kind: 'push'; ok: true }
	| { kind: 'push'; ok: false; reason: Refusal | 'actor-sequence-gap' };

export type PullResponse =
	| {
			kind: 'pull';
			ok: true;
			snapshotRequired: false;
			fromCursor: number;
			mutations: LoggedMutation[];
			newCursor: number;
			hasMore: boolean;
	  }
	| {
			kind: 'pull';
			ok: true;
			snapshotRequired: true;
			manifest: SnapshotManifest;
	  }
	| { kind: 'pull'; ok: false; reason: Refusal };

export type SnapshotChunkResponse =
	| { kind: 'snapshotChunk'; ok: true; chunk: SnapshotChunk }
	| {
			kind: 'snapshotChunk';
			ok: false;
			reason: Refusal | 'snapshot-replaced' | 'chunk-out-of-range';
	  };

export type SnapshotInstallResult =
	| { ok: true }
	| {
			ok: false;
			reason:
				| 'invalid-manifest'
				| 'stale-snapshot'
				| 'wrong-generation'
				| 'invalid-chunk'
				| 'incomplete-snapshot';
	  };

declare const rowKeyBrand: unique symbol;
export type RowKey = string & { readonly [rowKeyBrand]: true };
export type RowState = { deleted: boolean; cells: Cells };
export type LogicalState = Record<RowKey, RowState>;

export type VisibleDump = {
	rows: LogicalState;
	quarantine: LogicalState;
	tombstones: RowKey[];
};

export type ClientDump = VisibleDump & {
	actorId: string;
	nextActorSequence: number;
	pullCursor: number;
	outbox: Mutation[];
};

export function rowKey(table: string, rowId: string): RowKey {
	return `${table.length}:${table}${rowId}` as RowKey;
}

export function splitRowKey(key: RowKey): [table: string, rowId: string] {
	const separator = key.indexOf(':');
	const tableLength = Number(key.slice(0, separator));
	if (separator < 1 || !Number.isSafeInteger(tableLength) || tableLength < 0)
		throw new Error(`invalid internal row key: ${key}`);
	const tableStart = separator + 1;
	return [
		key.slice(tableStart, tableStart + tableLength),
		key.slice(tableStart + tableLength),
	];
}

export function mutationKey(mutation: Mutation): string {
	return `${mutation.actorId}:${mutation.actorSequence}`;
}

export function requestRefusal(
	request: RequestEnvelope,
	expected: RequestEnvelope = ENVELOPE,
): Refusal | null {
	if (request.protocolMajor !== expected.protocolMajor)
		return 'protocol-mismatch';
	if (request.schemaEpochId !== expected.schemaEpochId)
		return 'schema-epoch-mismatch';
	if (request.databaseIncarnationId !== expected.databaseIncarnationId)
		return 'database-incarnation-mismatch';
	return null;
}
