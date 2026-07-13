/** Gate 1-2 protocol: one immutable records history named by one epoch. */

export type RequestEnvelope = {
	protocolMajor: number;
	recordsEpoch: string;
};

export const ENVELOPE = {
	protocolMajor: 1,
	recordsEpoch: 'gate1-epoch-1',
} as const satisfies RequestEnvelope;

export type JsonCell = string | number | boolean | null;
export type Cells = Record<string, JsonCell>;

/**
 * Three verbs, no tombstones. createRow materializes an absent identity,
 * updateRow assigns named cells of a live row (null clears, absent row is an
 * accepted no-op), deleteRow physically removes (absent row is an accepted
 * no-op). A createRow naming a live identity is never accepted: the server
 * refuses the whole push and a replica folding it locally is corrupt.
 */
export type Operation =
	| { kind: 'createRow'; table: string; rowId: string; cells: Cells }
	| { kind: 'updateRow'; table: string; rowId: string; cells: Cells }
	| { kind: 'deleteRow'; table: string; rowId: string };

/** Actor identity plus its contiguous sequence is the mutation identity. */
export type Mutation = {
	actorId: string;
	actorSequence: number;
	operations: Operation[];
};

export type LoggedMutation = Mutation & { serverSequence: number };

/** Snapshots carry live rows only; deletion survives compaction as absence. */
export type SnapshotRow = {
	table: string;
	rowId: string;
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
	| 'records-epoch-mismatch';

export type PushResponse =
	| { kind: 'push'; ok: true }
	| {
			kind: 'push';
			ok: false;
			reason: Refusal | 'actor-sequence-gap' | 'create-conflict';
	  };

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
/** A row exists (its cells) or is absent. There is no deleted state. */
export type LogicalState = Record<RowKey, Cells>;

export type VisibleDump = {
	rows: LogicalState;
	quarantine: LogicalState;
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
	if (request.recordsEpoch !== expected.recordsEpoch)
		return 'records-epoch-mismatch';
	return null;
}
