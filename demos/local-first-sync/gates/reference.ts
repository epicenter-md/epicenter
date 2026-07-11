/**
 * Pure, deterministic, in-memory reference model. This IS the spec:
 * no I/O, no wall clock, no internal randomness.
 *
 * The fold (`applyOp`) is the single deterministic function every replica
 * runs over the accepted log. There is no per-op rejection at the server —
 * accepted mutations enter the log verbatim and the fold decides effects,
 * so any two replicas that folded the same prefix are byte-identical.
 */

import {
	type AppVersion,
	type CellMap,
	KNOWN_FIELDS,
	type LoggedMutation,
	type Mutation,
	type Op,
	type PullRequest,
	type PullResponse,
	type PushRequest,
	type PushResponse,
	type RegisterResponse,
	type RowState,
	SCHEMA_MAJOR_OF,
	type Snapshot,
} from './protocol';
import { checksumRows } from './util';

// ─── The fold ────────────────────────────────────────────────────────────────

export type FoldState = Map<string, RowState>;

export function applyOp(state: FoldState, op: Op): void {
	const row = state.get(op.rowId);
	if (op.kind === 'row-insert') {
		if (!row) {
			if (op.rowGen === 1) {
				state.set(op.rowId, { gen: 1, alive: true, cells: { ...op.cells } });
			}
		} else if (row.alive && op.rowGen === row.gen) {
			// Concurrent insert of the same stable rowId: cells merge
			// (this is what makes sign-in Add-import idempotent).
			Object.assign(row.cells, op.cells);
		} else if (!row.alive && op.rowGen === row.gen + 1) {
			// Explicit reinsert: fresh generation, old cells do NOT revive.
			state.set(op.rowId, {
				gen: op.rowGen,
				alive: true,
				cells: { ...op.cells },
			});
		}
		// else: stale insert/reinsert — no-op.
	} else if (op.kind === 'cell') {
		if (row?.alive && op.rowGen === row.gen) {
			row.cells[op.field] = op.value; // null = explicit clear
		}
		// else: dead/stale generation — a cell op can never resurrect a row.
	} else {
		if (row?.alive && op.rowGen === row.gen) {
			row.alive = false;
			row.cells = {}; // tombstone keeps (gen, ¬alive) only, forever
		}
	}
}

export function applyMutation(state: FoldState, mutation: Mutation): void {
	for (const op of mutation.ops) applyOp(state, op);
}

export function cloneState(state: FoldState): FoldState {
	const clone: FoldState = new Map();
	for (const [id, row] of state) {
		clone.set(id, { gen: row.gen, alive: row.alive, cells: { ...row.cells } });
	}
	return clone;
}

/** visible = fold(canonical, outbox in clientSeq order). The Gate-1 formula. */
export function foldVisible(
	canonical: FoldState,
	outbox: readonly Mutation[],
): FoldState {
	const visible = cloneState(canonical);
	for (const mutation of outbox) applyMutation(visible, mutation);
	return visible;
}

export function stateToRows(state: FoldState): Record<string, RowState> {
	const rows: Record<string, RowState> = {};
	for (const id of [...state.keys()].sort()) {
		const row = state.get(id)!;
		rows[id] = { gen: row.gen, alive: row.alive, cells: { ...row.cells } };
	}
	return rows;
}

export function stateFromRows(rows: Record<string, RowState>): FoldState {
	const state: FoldState = new Map();
	for (const [id, row] of Object.entries(rows)) {
		state.set(id, { gen: row.gen, alive: row.alive, cells: { ...row.cells } });
	}
	return state;
}

// ─── Typed projection (visible → app-facing rows) ────────────────────────────

/**
 * The app-facing shape: known fields as typed columns (absent and cleared
 * both surface as null — honest SQL column semantics), unknown fields
 * carried verbatim in the `extra` sidecar. Alive rows only.
 */
export type ProjectedRow = {
	id: string;
	gen: number;
	fields: Record<string, unknown>; // every known field, value ?? null
	extra: CellMap;
};

export function project(
	state: FoldState,
	appVersion: AppVersion,
): ProjectedRow[] {
	const known = KNOWN_FIELDS[appVersion];
	const rows: ProjectedRow[] = [];
	for (const id of [...state.keys()].sort()) {
		const row = state.get(id)!;
		if (!row.alive) continue;
		const fields: Record<string, unknown> = {};
		for (const field of known) fields[field] = row.cells[field] ?? null;
		const extra: CellMap = {};
		for (const [field, value] of Object.entries(row.cells)) {
			if (!known.includes(field)) extra[field] = value;
		}
		rows.push({ id, gen: row.gen, fields, extra });
	}
	return rows;
}

// ─── Reference server ────────────────────────────────────────────────────────

export type ServerDump = {
	seq: number;
	watermark: number;
	rows: Record<string, RowState>;
	lastClientSeq: Record<string, number>;
	snapshotSeq: number;
	checksum: string;
};

export class RefServer {
	schemaMajor: number;
	seq = 0;
	watermark = 0;
	log: LoggedMutation[] = []; // only seq > watermark retained
	state: FoldState = new Map();
	lastClientSeq = new Map<string, number>();
	nextClientNum = 1;
	snapshot: Snapshot | null = null;
	acceptedMutationIds = new Set<string>(); // harness assertion only

	constructor(schemaMajor: number) {
		this.schemaMajor = schemaMajor;
	}

	register(): RegisterResponse {
		const clientId = `c${this.nextClientNum++}`;
		this.lastClientSeq.set(clientId, 0);
		return { kind: 'register', clientId };
	}

	/**
	 * Accept mutations one atomic transaction each. `acceptOnlyFirst`
	 * simulates a server crash mid-push: an accepted prefix is durable,
	 * the response is lost.
	 */
	push(req: PushRequest, acceptOnlyFirst?: number): PushResponse {
		if (req.schemaMajor !== this.schemaMajor) {
			return { kind: 'push', ok: false, reason: 'schema-mismatch' };
		}
		const upTo = acceptOnlyFirst ?? req.mutations.length;
		for (let i = 0; i < upTo; i++) {
			const mutation = req.mutations[i];
			const last = this.lastClientSeq.get(mutation.clientId);
			if (last === undefined) {
				throw new Error(`push from unregistered client ${mutation.clientId}`);
			}
			if (mutation.clientSeq <= last) continue; // duplicate delivery
			if (mutation.clientSeq > last + 1) {
				return { kind: 'push', ok: false, reason: 'client-seq-gap' };
			}
			if (this.acceptedMutationIds.has(mutation.mutationId)) {
				throw new Error(
					`mutationId reuse across distinct clientSeq: ${mutation.mutationId}`,
				);
			}
			this.acceptedMutationIds.add(mutation.mutationId);
			this.seq += 1;
			this.log.push({ ...structuredClone(mutation), seq: this.seq });
			applyMutation(this.state, mutation);
			this.lastClientSeq.set(mutation.clientId, mutation.clientSeq);
		}
		return { kind: 'push', ok: true };
	}

	pull(req: PullRequest): PullResponse {
		if (req.schemaMajor !== this.schemaMajor) {
			return { kind: 'pull', ok: false, reason: 'schema-mismatch' };
		}
		if (req.cursor < this.watermark) {
			return {
				kind: 'pull',
				ok: true,
				snapshotRequired: true,
				snapshot: structuredClone(this.snapshot!),
			};
		}
		const mutations = this.log
			.filter((entry) => entry.seq > req.cursor)
			.slice(0, req.limit)
			.map((entry) => structuredClone(entry));
		const newCursor =
			mutations.length > 0 ? mutations[mutations.length - 1].seq : req.cursor;
		return {
			kind: 'pull',
			ok: true,
			snapshotRequired: false,
			fromCursor: req.cursor,
			mutations,
			newCursor,
			hasMore: this.seq > newCursor,
		};
	}

	/**
	 * Compaction: snapshot the fold AS OF upTo (previous snapshot + retained
	 * log ≤ upTo — NOT the current head state), then delete log ≤ upTo.
	 * lastClientSeq in the snapshot is likewise as-of upTo; carrying the head
	 * values would make installers over-prune outboxes and lose intent.
	 */
	compact(upTo: number): void {
		upTo = Math.min(upTo, this.seq);
		if (upTo <= this.watermark) return;
		const state = this.snapshot
			? stateFromRows(this.snapshot.rows)
			: new Map<string, RowState>();
		const lastClientSeq: Record<string, number> = {
			...(this.snapshot?.lastClientSeq ?? {}),
		};
		for (const entry of this.log) {
			if (entry.seq > upTo) break;
			applyMutation(state, entry);
			lastClientSeq[entry.clientId] = Math.max(
				lastClientSeq[entry.clientId] ?? 0,
				entry.clientSeq,
			);
		}
		const rows = stateToRows(state);
		this.snapshot = {
			snapshotSeq: upTo,
			rows,
			lastClientSeq,
			checksum: checksumRows(rows),
		};
		this.log = this.log.filter((entry) => entry.seq > upTo);
		this.watermark = upTo;
	}

	/** Reboot: all server state is durable; in-flight loss is the harness's. */
	crashReboot(): void {}

	dump(): ServerDump {
		const rows = stateToRows(this.state);
		return {
			seq: this.seq,
			watermark: this.watermark,
			rows,
			lastClientSeq: Object.fromEntries(
				[...this.lastClientSeq.entries()].sort(),
			),
			snapshotSeq: this.snapshot?.snapshotSeq ?? 0,
			checksum: checksumRows(rows),
		};
	}
}

// ─── Reference client ────────────────────────────────────────────────────────

/** Everything durable for one profile — one SQLite file in the real engine. */
type ProfileDb = {
	clientId: string | null;
	clientSeqCounter: number;
	cursor: number;
	canonical: FoldState;
	outbox: Mutation[];
	appVersion: AppVersion;
};

export type GenTag = { dbGen: number; sessionGen: number };

export type WriteSpecOp =
	| { kind: 'insert'; rowId: string; cells: CellMap }
	| { kind: 'cell'; rowId: string; field: string; value: JsonCellLike }
	| { kind: 'delete'; rowId: string }
	| { kind: 'reinsert'; rowId: string; cells: CellMap };
type JsonCellLike = string | number | boolean | null;

export type ClientDump = {
	activeProfile: string;
	dbGen: number;
	signedIn: boolean;
	paused: boolean;
	profiles: Record<
		string,
		{
			clientId: string | null;
			clientSeqCounter: number;
			cursor: number;
			appVersion: AppVersion;
			canonical: Record<string, RowState>;
			outbox: Mutation[];
			visible: ProjectedRow[];
		}
	>;
};

export class RefClient {
	profiles = new Map<string, ProfileDb>();
	activeProfile: string;
	/** DURABLE and bumped on every reboot + profile switch: a stale in-flight
	 * response must never survive either boundary. */
	dbGen = 0;
	/** Volatile; reset on reboot (safe because reboot bumps dbGen). */
	sessionGen = 0;
	signedIn = false;
	paused = false; // volatile: schema-mismatch pause, re-probed after reboot

	constructor(initialProfile: string, appVersion: AppVersion) {
		this.activeProfile = initialProfile;
		this.profiles.set(initialProfile, freshProfile(appVersion));
	}

	get db(): ProfileDb {
		return this.profiles.get(this.activeProfile)!;
	}

	tag(): GenTag {
		return { dbGen: this.dbGen, sessionGen: this.sessionGen };
	}

	private tagCurrent(tag: GenTag): boolean {
		return tag.dbGen === this.dbGen && tag.sessionGen === this.sessionGen;
	}

	visibleFold(): FoldState {
		return foldVisible(this.db.canonical, this.db.outbox);
	}

	/** Local write: stamp rowGens from the VISIBLE fold, append to outbox.
	 * One durable transaction. Allowed signed-out — local-first. */
	localWrite(specOps: WriteSpecOp[], mutationId: string): void {
		const visible = this.visibleFold();
		const ops: Op[] = specOps.map((spec) => {
			const row = visible.get(spec.rowId);
			switch (spec.kind) {
				case 'insert': {
					if (row) throw new Error(`insert on existing row ${spec.rowId}`);
					// Track locally so later ops in the SAME mutation stamp right.
					visible.set(spec.rowId, { gen: 1, alive: true, cells: {} });
					return {
						kind: 'row-insert',
						rowId: spec.rowId,
						rowGen: 1,
						cells: spec.cells,
					};
				}
				case 'cell': {
					if (!row?.alive) throw new Error(`cell on dead row ${spec.rowId}`);
					return {
						kind: 'cell',
						rowId: spec.rowId,
						rowGen: row.gen,
						field: spec.field,
						value: spec.value,
					};
				}
				case 'delete': {
					if (!row?.alive) throw new Error(`delete on dead row ${spec.rowId}`);
					visible.set(spec.rowId, { gen: row.gen, alive: false, cells: {} });
					return { kind: 'row-delete', rowId: spec.rowId, rowGen: row.gen };
				}
				case 'reinsert': {
					if (!row || row.alive) {
						throw new Error(`reinsert on live/absent row ${spec.rowId}`);
					}
					visible.set(spec.rowId, {
						gen: row.gen + 1,
						alive: true,
						cells: {},
					});
					return {
						kind: 'row-insert',
						rowId: spec.rowId,
						rowGen: row.gen + 1,
						cells: spec.cells,
					};
				}
			}
		});
		this.db.clientSeqCounter += 1;
		this.db.outbox.push({
			mutationId,
			clientId: this.db.clientId ?? 'unregistered',
			clientSeq: this.db.clientSeqCounter,
			ops,
		});
	}

	buildRegister(): { req: { kind: 'register' }; tag: GenTag } | null {
		if (!this.signedIn || this.paused || this.db.clientId !== null)
			return null;
		return { req: { kind: 'register' }, tag: this.tag() };
	}

	handleRegister(resp: RegisterResponse, tag: GenTag): void {
		if (!this.tagCurrent(tag)) return;
		if (this.db.clientId !== null) return; // duplicate response
		this.db.clientId = resp.clientId;
		// Mutations written before registration carry the placeholder id.
		for (const mutation of this.db.outbox) {
			mutation.clientId = resp.clientId;
		}
	}

	buildPush(): { req: PushRequest; tag: GenTag } | null {
		if (!this.signedIn || this.paused) return null;
		if (this.db.clientId === null || this.db.outbox.length === 0) return null;
		return {
			req: {
				kind: 'push',
				schemaMajor: SCHEMA_MAJOR_OF[this.db.appVersion],
				clientId: this.db.clientId,
				mutations: structuredClone(this.db.outbox),
			},
			tag: this.tag(),
		};
	}

	handlePush(resp: PushResponse, tag: GenTag): void {
		if (!this.tagCurrent(tag)) return;
		if (!resp.ok && resp.reason === 'schema-mismatch') this.paused = true;
		// Acks NEVER prune the outbox: pruning before the echo is in canonical
		// would transiently lose pending intent (the demo's admitted flaw).
	}

	buildPull(limit: number): { req: PullRequest; tag: GenTag } | null {
		if (!this.signedIn || this.paused) return null;
		return {
			req: {
				kind: 'pull',
				schemaMajor: SCHEMA_MAJOR_OF[this.db.appVersion],
				cursor: this.db.cursor,
				limit,
			},
			tag: this.tag(),
		};
	}

	handlePull(resp: PullResponse, tag: GenTag): void {
		if (!this.tagCurrent(tag)) return; // wrong db/session: discard wholesale
		if (!resp.ok) {
			this.paused = true;
			return;
		}
		const db = this.db;
		if (resp.snapshotRequired) {
			const { snapshot } = resp;
			if (checksumRows(snapshot.rows) !== snapshot.checksum) {
				throw new Error('snapshot checksum mismatch');
			}
			// ONE atomic transaction: install + cursor + prune. The remaining
			// outbox replays on top, so a years-stale client keeps its intent.
			db.canonical = stateFromRows(snapshot.rows);
			db.cursor = snapshot.snapshotSeq;
			if (db.clientId !== null) {
				const acked = snapshot.lastClientSeq[db.clientId] ?? 0;
				db.outbox = db.outbox.filter((m) => m.clientSeq > acked);
			}
			return;
		}
		// CAS on cursor: stale or duplicated page responses are inert.
		if (resp.fromCursor !== db.cursor) return;
		// ONE atomic transaction: fold page + prune echoes + advance cursor.
		for (const mutation of resp.mutations) {
			applyMutation(db.canonical, mutation);
		}
		if (db.clientId !== null) {
			const echoed = new Set(
				resp.mutations
					.filter((m) => m.clientId === db.clientId)
					.map((m) => m.clientSeq),
			);
			if (echoed.size > 0) {
				db.outbox = db.outbox.filter((m) => !echoed.has(m.clientSeq));
			}
		}
		db.cursor = resp.newCursor;
	}

	crashReboot(): void {
		this.dbGen += 1; // durable bump: pre-crash in-flight can never land
		this.sessionGen = 0;
		this.paused = false;
	}

	signIn(): void {
		this.signedIn = true;
		this.sessionGen += 1;
	}

	signOut(): void {
		this.signedIn = false;
		this.sessionGen += 1;
	}

	switchProfile(profile: string, appVersionIfNew: AppVersion): void {
		if (!this.profiles.has(profile)) {
			this.profiles.set(profile, freshProfile(appVersionIfNew));
		}
		this.activeProfile = profile;
		this.dbGen += 1;
	}

	/** v1 → v2: the visible projection is derived, so "promotion" is just
	 * re-projection with the wider known-field set. Exactly once, no merge. */
	upgrade(to: AppVersion): void {
		this.db.appVersion = to;
		this.paused = false; // re-probe against the server's major
	}

	dump(): ClientDump {
		const profiles: ClientDump['profiles'] = {};
		for (const [name, db] of [...this.profiles.entries()].sort()) {
			const visible = foldVisible(db.canonical, db.outbox);
			profiles[name] = {
				clientId: db.clientId,
				clientSeqCounter: db.clientSeqCounter,
				cursor: db.cursor,
				appVersion: db.appVersion,
				canonical: stateToRows(db.canonical),
				outbox: structuredClone(db.outbox),
				visible: project(visible, db.appVersion),
			};
		}
		return {
			activeProfile: this.activeProfile,
			dbGen: this.dbGen,
			signedIn: this.signedIn,
			paused: this.paused,
			profiles,
		};
	}
}

function freshProfile(appVersion: AppVersion): ProfileDb {
	return {
		clientId: null,
		clientSeqCounter: 0,
		cursor: 0,
		canonical: new Map(),
		outbox: [],
		appVersion,
	};
}
