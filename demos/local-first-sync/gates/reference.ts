/** Pure reference model. It deliberately shares no persistence code with SQLite. */

import {
	type Cells,
	type ClientDump,
	ENVELOPE,
	type LogicalState,
	type Mutation,
	mutationKey,
	type Operation,
	type PullRequest,
	type PullResponse,
	type PushRequest,
	type PushResponse,
	type RequestEnvelope,
	type RowKey,
	requestRefusal,
	rowKey,
	type SnapshotChunk,
	type SnapshotChunkRequest,
	type SnapshotChunkResponse,
	type SnapshotInstallResult,
	type SnapshotManifest,
	type SnapshotRow,
	splitRowKey,
} from './protocol';
import {
	createSnapshotChunk,
	createSnapshotManifest,
	isValidSnapshotChunk,
	isValidSnapshotManifest,
} from './snapshot-codec';

/**
 * The total fold over accepted or pending operations. createRow(live) is not
 * part of the fold: the server refuses it before acceptance, so a replica
 * that folds into it is corrupt and must discard state and rebootstrap.
 */
function applyOperation(state: LogicalState, operation: Operation): void {
	const key = rowKey(operation.table, operation.rowId);
	if (operation.kind === 'createRow') {
		if (state[key])
			throw new Error(
				`replica corrupt: createRow for live row ${operation.table}/${operation.rowId}`,
			);
		const cells: Cells = {};
		for (const [field, value] of Object.entries(operation.cells))
			if (value !== null) cells[field] = value;
		state[key] = cells;
		return;
	}
	if (operation.kind === 'deleteRow') {
		delete state[key];
		return;
	}
	const row = state[key];
	if (!row) return;
	for (const [field, value] of Object.entries(operation.cells)) {
		if (value === null) delete row[field];
		else row[field] = value;
	}
}

function applyMutation(state: LogicalState, mutation: Mutation): void {
	for (const operation of mutation.operations) applyOperation(state, operation);
}

function visible(
	canonical: LogicalState,
	outbox: readonly Mutation[],
): LogicalState {
	const result = structuredClone(canonical);
	for (const mutation of outbox) applyMutation(result, mutation);
	return result;
}

function classify(
	state: LogicalState,
): Pick<ClientDump, 'rows' | 'quarantine'> {
	const rows: LogicalState = {};
	const quarantine: LogicalState = {};
	for (const key of Object.keys(state).sort() as RowKey[]) {
		const cells = state[key];
		const [table] = splitRowKey(key);
		const fields = Object.keys(cells).sort();
		const valid =
			(table === 'notes' &&
				fields.every((field) => field === 'title' || field === 'pinned') &&
				typeof cells.title === 'string' &&
				typeof cells.pinned === 'boolean') ||
			(table === 'folders' &&
				fields.length === 1 &&
				typeof cells.name === 'string');
		(valid ? rows : quarantine)[key] = structuredClone(cells);
	}
	return { rows, quarantine };
}

export class RefServer {
	private envelope: RequestEnvelope;
	private serverSequence = 0;
	private watermark = 0;
	private snapshotGeneration = 0;
	private actorHighWater = new Map<string, number>();
	private canonical: LogicalState = {};
	private readonly log: (Mutation & { serverSequence: number })[] = [];
	private manifest: SnapshotManifest | null = null;
	private chunks: SnapshotChunk[] = [];

	constructor(envelope: RequestEnvelope = ENVELOPE) {
		this.envelope = structuredClone(envelope);
	}

	push(
		request: PushRequest,
		acceptLimit = Number.POSITIVE_INFINITY,
	): PushResponse {
		const refusal = requestRefusal(request, this.envelope);
		if (refusal) return { kind: 'push', ok: false, reason: refusal };
		// createRow(live) refuses the WHOLE push atomically: no earlier mutation
		// in the batch commits and no actor high-water advances.
		const rollback = {
			serverSequence: this.serverSequence,
			canonical: structuredClone(this.canonical),
			logLength: this.log.length,
			actorHighWater: new Map(this.actorHighWater),
		};
		let accepted = 0;
		for (const mutation of request.mutations) {
			if (accepted >= acceptLimit) break;
			const highWater = this.actorHighWater.get(mutation.actorId) ?? 0;
			if (mutation.actorSequence <= highWater) continue;
			if (mutation.actorSequence !== highWater + 1)
				return { kind: 'push', ok: false, reason: 'actor-sequence-gap' };
			for (const operation of mutation.operations) {
				if (
					operation.kind === 'createRow' &&
					this.canonical[rowKey(operation.table, operation.rowId)]
				) {
					this.serverSequence = rollback.serverSequence;
					this.canonical = rollback.canonical;
					this.log.length = rollback.logLength;
					this.actorHighWater = rollback.actorHighWater;
					return { kind: 'push', ok: false, reason: 'create-conflict' };
				}
				applyOperation(this.canonical, operation);
			}
			this.serverSequence += 1;
			this.log.push({
				...structuredClone(mutation),
				serverSequence: this.serverSequence,
			});
			this.actorHighWater.set(mutation.actorId, mutation.actorSequence);
			accepted += 1;
		}
		return { kind: 'push', ok: true };
	}

	pull(request: PullRequest): PullResponse {
		const refusal = requestRefusal(request, this.envelope);
		if (refusal) return { kind: 'pull', ok: false, reason: refusal };
		if (request.cursor < this.watermark) {
			if (!this.manifest)
				throw new Error('watermark has no published snapshot');
			return {
				kind: 'pull',
				ok: true,
				snapshotRequired: true,
				manifest: structuredClone(this.manifest),
			};
		}
		const mutations = this.log
			.filter(({ serverSequence }) => serverSequence > request.cursor)
			.slice(0, request.limit)
			.map((mutation) => structuredClone(mutation));
		const newCursor = mutations.at(-1)?.serverSequence ?? request.cursor;
		return {
			kind: 'pull',
			ok: true,
			snapshotRequired: false,
			fromCursor: request.cursor,
			mutations,
			newCursor,
			hasMore: newCursor < this.serverSequence,
		};
	}

	publishSnapshot(rowsPerChunk: number): SnapshotManifest {
		if (!Number.isSafeInteger(rowsPerChunk) || rowsPerChunk < 1)
			throw new Error('rowsPerChunk must be a positive integer');
		this.snapshotGeneration += 1;
		// Every canonical row is live: deletion already happened physically, so
		// the snapshot carries deletion as absence.
		const rows = (Object.entries(this.canonical) as [RowKey, Cells][])
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, cells]): SnapshotRow => {
				const [table, rowId] = splitRowKey(key);
				return { table, rowId, cells: structuredClone(cells) };
			});
		const rowPages: SnapshotRow[][] = [];
		for (let start = 0; start < rows.length; start += rowsPerChunk)
			rowPages.push(rows.slice(start, start + rowsPerChunk));
		if (rowPages.length === 0) rowPages.push([]);
		this.chunks = rowPages.map((page, index) =>
			createSnapshotChunk(this.snapshotGeneration, index, page),
		);
		this.manifest = createSnapshotManifest({
			generation: this.snapshotGeneration,
			snapshotSequence: this.serverSequence,
			chunkChecksums: this.chunks.map(({ checksum }) => checksum),
			actorHighWater: Object.fromEntries([...this.actorHighWater].sort()),
		});
		this.watermark = this.serverSequence;
		this.log.length = 0;
		return structuredClone(this.manifest);
	}

	snapshotChunk(request: SnapshotChunkRequest): SnapshotChunkResponse {
		const refusal = requestRefusal(request, this.envelope);
		if (refusal) return { kind: 'snapshotChunk', ok: false, reason: refusal };
		if (!this.manifest || request.generation !== this.manifest.generation)
			return { kind: 'snapshotChunk', ok: false, reason: 'snapshot-replaced' };
		const chunk = this.chunks[request.index];
		if (!chunk)
			return { kind: 'snapshotChunk', ok: false, reason: 'chunk-out-of-range' };
		return { kind: 'snapshotChunk', ok: true, chunk: structuredClone(chunk) };
	}

	dump() {
		return {
			serverSequence: this.serverSequence,
			watermark: this.watermark,
			canonical: structuredClone(this.canonical),
			actorHighWater: Object.fromEntries([...this.actorHighWater].sort()),
			log: structuredClone(this.log),
			manifest: structuredClone(this.manifest),
			chunks: structuredClone(this.chunks),
		};
	}
}

export class RefClient {
	private envelope: RequestEnvelope;
	private canonical: LogicalState = {};
	private outbox: Mutation[] = [];
	private pullCursor = 0;
	private nextActorSequence = 1;
	private stagedManifest: SnapshotManifest | null = null;
	private stagedChunks = new Map<number, SnapshotChunk>();

	constructor(
		readonly actorId: string,
		envelope: RequestEnvelope = ENVELOPE,
	) {
		this.envelope = structuredClone(envelope);
	}

	local(operations: Operation[]): void {
		const mutation = {
			actorId: this.actorId,
			actorSequence: this.nextActorSequence,
			operations: structuredClone(operations),
		};
		this.nextActorSequence += 1;
		this.outbox.push(mutation);
	}

	pushRequest(): PushRequest {
		return {
			kind: 'push',
			...this.envelope,
			mutations: structuredClone(this.outbox),
		};
	}

	pullRequest(limit = 100): PullRequest {
		return { kind: 'pull', ...this.envelope, cursor: this.pullCursor, limit };
	}

	applyPull(response: PullResponse): boolean {
		if (
			!response.ok ||
			response.snapshotRequired ||
			response.fromCursor !== this.pullCursor
		)
			return false;
		for (const mutation of response.mutations)
			applyMutation(this.canonical, mutation);
		const echoed = new Set(response.mutations.map(mutationKey));
		this.outbox = this.outbox.filter(
			(mutation) => !echoed.has(mutationKey(mutation)),
		);
		this.pullCursor = response.newCursor;
		return true;
	}

	beginSnapshot(manifest: SnapshotManifest): SnapshotInstallResult {
		if (!isValidSnapshotManifest(manifest))
			return { ok: false, reason: 'invalid-manifest' };
		if (manifest.snapshotSequence <= this.pullCursor)
			return { ok: false, reason: 'stale-snapshot' };
		if (this.stagedManifest?.checksum !== manifest.checksum) {
			this.stagedManifest = structuredClone(manifest);
			this.stagedChunks.clear();
		}
		return { ok: true };
	}

	stageSnapshotChunk(chunk: SnapshotChunk): SnapshotInstallResult {
		const manifest = this.stagedManifest;
		if (!manifest || chunk.generation !== manifest.generation)
			return { ok: false, reason: 'wrong-generation' };
		if (
			chunk.index < 0 ||
			chunk.index >= manifest.chunkChecksums.length ||
			manifest.chunkChecksums[chunk.index] !== chunk.checksum ||
			!isValidSnapshotChunk(chunk)
		)
			return { ok: false, reason: 'invalid-chunk' };
		const existing = this.stagedChunks.get(chunk.index);
		if (existing && existing.checksum !== chunk.checksum)
			return { ok: false, reason: 'invalid-chunk' };
		this.stagedChunks.set(chunk.index, structuredClone(chunk));
		return { ok: true };
	}

	installSnapshot(): SnapshotInstallResult {
		const manifest = this.stagedManifest;
		if (!manifest || this.stagedChunks.size !== manifest.chunkChecksums.length)
			return { ok: false, reason: 'incomplete-snapshot' };
		if (manifest.snapshotSequence <= this.pullCursor)
			return { ok: false, reason: 'stale-snapshot' };
		const next: LogicalState = {};
		for (let index = 0; index < manifest.chunkChecksums.length; index += 1) {
			const chunk = this.stagedChunks.get(index);
			if (!chunk) return { ok: false, reason: 'incomplete-snapshot' };
			for (const row of chunk.rows)
				next[rowKey(row.table, row.rowId)] = structuredClone(row.cells);
		}
		this.canonical = next;
		const acceptedThrough = manifest.actorHighWater[this.actorId] ?? 0;
		this.outbox = this.outbox.filter(
			({ actorSequence }) => actorSequence > acceptedThrough,
		);
		// A rebootstrapped replica must never reuse an accepted sequence: the
		// server would silently dedup it and the mutation would be lost.
		this.nextActorSequence = Math.max(
			this.nextActorSequence,
			acceptedThrough + 1,
		);
		this.pullCursor = manifest.snapshotSequence;
		this.stagedManifest = null;
		this.stagedChunks.clear();
		return { ok: true };
	}

	dump(): ClientDump {
		return {
			actorId: this.actorId,
			nextActorSequence: this.nextActorSequence,
			pullCursor: this.pullCursor,
			outbox: structuredClone(this.outbox),
			...classify(visible(this.canonical, this.outbox)),
		};
	}
}
