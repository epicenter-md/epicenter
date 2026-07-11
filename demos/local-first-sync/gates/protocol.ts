/**
 * Protocol v2 (gates variant): the hardened shape the decision memo priced.
 *
 * Differences from the demo protocol:
 *  - the sync unit is an atomic MUTATION (UUIDv7 id, server-assigned clientId,
 *    per-client contiguous clientSeq) carrying one or more ops;
 *  - every op addresses a row GENERATION (delete = permanent tombstone,
 *    reinsert = gen + 1, no resurrection);
 *  - pull supports pagination, a compaction watermark, and snapshot-required
 *    bootstrap with checksums.
 */

export type JsonCell = string | number | boolean | null;
export type CellMap = Record<string, JsonCell>;

export type Op =
	| { kind: 'row-insert'; rowId: string; rowGen: number; cells: CellMap }
	| {
			kind: 'cell';
			rowId: string;
			rowGen: number;
			field: string;
			value: JsonCell;
	  }
	| { kind: 'row-delete'; rowId: string; rowGen: number };

/** The atomic unit of sync. All ops apply in one transition or none. */
export type Mutation = {
	mutationId: string; // UUIDv7 (deterministic in the harness)
	clientId: string; // server-assigned
	clientSeq: number; // per-client contiguous counter, 1-based
	ops: Op[];
};

export type LoggedMutation = Mutation & { seq: number };

/** Canonical row state: tombstones (alive=false) are permanent. */
export type RowState = { gen: number; alive: boolean; cells: CellMap };

export type Snapshot = {
	snapshotSeq: number;
	/** Includes tombstones — folds must agree across replicas. */
	rows: Record<string, RowState>;
	/** As of snapshotSeq, NOT as of the server head. */
	lastClientSeq: Record<string, number>;
	checksum: string;
};

export type RegisterRequest = { kind: 'register' };
export type PushRequest = {
	kind: 'push';
	schemaMajor: number;
	clientId: string;
	mutations: Mutation[];
};
export type PullRequest = {
	kind: 'pull';
	schemaMajor: number;
	cursor: number;
	limit: number;
};
export type SyncRequest = RegisterRequest | PushRequest | PullRequest;

export type RegisterResponse = { kind: 'register'; clientId: string };
export type PushResponse =
	| { kind: 'push'; ok: true }
	| { kind: 'push'; ok: false; reason: 'schema-mismatch' | 'client-seq-gap' };
export type PullResponse =
	| { kind: 'pull'; ok: true; snapshotRequired: true; snapshot: Snapshot }
	| {
			kind: 'pull';
			ok: true;
			snapshotRequired: false;
			fromCursor: number;
			mutations: LoggedMutation[];
			newCursor: number;
			hasMore: boolean;
	  }
	| { kind: 'pull'; ok: false; reason: 'schema-mismatch' };
export type SyncResponse = RegisterResponse | PushResponse | PullResponse;

export const SERVER_SCHEMA_MAJOR = 2;

export type AppVersion = 1 | 2 | 3;

export const KNOWN_FIELDS: Record<AppVersion, readonly string[]> = {
	1: ['title', 'pinned', 'updatedAt'],
	2: ['title', 'pinned', 'updatedAt', 'subtitle'],
	3: ['title', 'pinned', 'updatedAt', 'subtitle', 'futureField'],
};

/** v1 and v2 are additive within major 2; v3 simulates a major bump. */
export const SCHEMA_MAJOR_OF: Record<AppVersion, number> = { 1: 2, 2: 2, 3: 3 };
