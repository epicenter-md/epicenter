import { transformRows } from './epoch-planner';
import type {
	BeginTransition,
	BuildTransitionResult,
	EpochAuthority,
	EpochAuthorityDump,
	EpochPushResult,
	EpochTransform,
	IncarnationDump,
	TransitionResult,
} from './epoch-protocol';
import type { Operation, PushRequest, SnapshotRow } from './protocol';

type Incarnation = Omit<IncarnationDump, 'actorHighWater'> & {
	actorHighWater: Map<string, number>;
};

export class RefEpochAuthority implements EpochAuthority {
	private activeIncarnationId: string;
	private incarnations = new Map<string, Incarnation>();
	private transition: EpochAuthorityDump['transition'] = null;
	private currentTransform: EpochTransform | null = null;

	constructor(initial: { id: string; epochId: string; rows: SnapshotRow[] }) {
		this.activeIncarnationId = initial.id;
		this.incarnations.set(initial.id, {
			id: initial.id,
			epochId: initial.epochId,
			status: 'active',
			head: 0,
			rows: structuredClone(initial.rows),
			actorHighWater: new Map(),
		});
	}

	push(request: PushRequest): EpochPushResult {
		const active = this.incarnations.get(this.activeIncarnationId);
		if (!active) throw new Error('active incarnation missing');
		if (request.protocolMajor !== 1)
			return { ok: false, reason: 'protocol-mismatch' };
		if (request.schemaEpochId !== active.epochId)
			return { ok: false, reason: 'schema-epoch-mismatch' };
		if (request.databaseIncarnationId !== active.id)
			return { ok: false, reason: 'database-incarnation-mismatch' };
		if (active.status === 'frozen')
			return { ok: false, reason: 'transition-frozen' };
		for (const mutation of request.mutations) {
			const highWater = active.actorHighWater.get(mutation.actorId) ?? 0;
			if (mutation.actorSequence <= highWater) continue;
			if (mutation.actorSequence !== highWater + 1)
				return { ok: false, reason: 'actor-sequence-gap' };
			for (const operation of mutation.operations)
				apply(active.rows, operation);
			active.actorHighWater.set(mutation.actorId, mutation.actorSequence);
			active.head += 1;
		}
		return { ok: true };
	}

	beginTransition(request: BeginTransition): TransitionResult {
		if (this.transition) return { ok: false, reason: 'transition-in-progress' };
		if (this.incarnations.has(request.targetIncarnationId))
			return { ok: false, reason: 'target-incarnation-exists' };
		const source = this.incarnations.get(this.activeIncarnationId);
		if (!source) throw new Error('active incarnation missing');
		if (
			request.transform.fromEpochId !== source.epochId ||
			request.transform.toEpochId.length === 0 ||
			request.transform.toEpochId === source.epochId
		)
			return { ok: false, reason: 'epoch-mismatch' };
		source.rows.sort(compareRows);
		const preflight = transformRows(source.rows, request.transform);
		if (!preflight.result.ok) return preflight.result;
		source.status = 'frozen';
		this.incarnations.set(request.targetIncarnationId, {
			id: request.targetIncarnationId,
			epochId: request.transform.toEpochId,
			status: 'preparing',
			head: 0,
			rows: [],
			actorHighWater: new Map(),
		});
		this.transition = {
			leaseId: request.leaseId,
			sourceIncarnationId: source.id,
			targetIncarnationId: request.targetIncarnationId,
			expiresAt: request.expiresAt,
			nextRowIndex: 0,
			totalRows: source.rows.length,
		};
		this.currentTransform = structuredClone(request.transform);
		return { ok: true };
	}

	buildTransition(
		leaseId: string,
		batchSize: number,
		now: number,
	): BuildTransitionResult {
		if (!this.transition) return { ok: false, reason: 'no-transition' };
		if (this.transition.leaseId !== leaseId)
			return { ok: false, reason: 'wrong-lease' };
		if (now >= this.transition.expiresAt)
			return { ok: false, reason: 'lease-expired' };
		if (!Number.isSafeInteger(batchSize) || batchSize < 1)
			throw new Error('batchSize must be a positive integer');
		const source = this.incarnations.get(this.transition.sourceIncarnationId);
		const target = this.incarnations.get(this.transition.targetIncarnationId);
		if (!source || !target) throw new Error('transition incarnation missing');
		const start = this.transition.nextRowIndex;
		const rows = source.rows.slice(start, start + batchSize);
		const transform = this.currentTransform;
		if (!transform) throw new Error('transition transform missing');
		const transformed = transformRows(rows, transform);
		if (!transformed.result.ok)
			throw new Error(
				`preflight/build disagreement: ${transformed.result.reason}`,
			);
		target.rows.push(...transformed.rows);
		this.transition.nextRowIndex += rows.length;
		return {
			ok: true,
			complete: this.transition.nextRowIndex === this.transition.totalRows,
		};
	}

	activate(leaseId: string, now: number): TransitionResult {
		if (!this.transition) return { ok: false, reason: 'no-transition' };
		if (this.transition.leaseId !== leaseId)
			return { ok: false, reason: 'wrong-lease' };
		if (now >= this.transition.expiresAt)
			return { ok: false, reason: 'lease-expired' };
		if (this.transition.nextRowIndex !== this.transition.totalRows)
			return { ok: false, reason: 'baseline-incomplete' };
		const source = this.incarnations.get(this.transition.sourceIncarnationId);
		const target = this.incarnations.get(this.transition.targetIncarnationId);
		if (!source || !target) throw new Error('transition incarnation missing');
		source.status = 'superseded';
		target.status = 'active';
		this.activeIncarnationId = target.id;
		this.transition = null;
		this.currentTransform = null;
		return { ok: true };
	}

	expire(now: number): TransitionResult {
		if (!this.transition) return { ok: false, reason: 'no-transition' };
		if (now < this.transition.expiresAt)
			return { ok: false, reason: 'lease-not-expired' };
		const source = this.incarnations.get(this.transition.sourceIncarnationId);
		if (!source) throw new Error('transition source missing');
		source.status = 'active';
		this.incarnations.delete(this.transition.targetIncarnationId);
		this.transition = null;
		this.currentTransform = null;
		return { ok: true };
	}

	dump(): EpochAuthorityDump {
		return {
			activeIncarnationId: this.activeIncarnationId,
			incarnations: [...this.incarnations.values()]
				.sort((left, right) => left.id.localeCompare(right.id))
				.map((incarnation) => ({
					...structuredClone(incarnation),
					rows: structuredClone(incarnation.rows).sort(compareRows),
					actorHighWater: Object.fromEntries(
						[...incarnation.actorHighWater].sort(),
					),
				})),
			transition: structuredClone(this.transition),
		};
	}
}

function apply(rows: SnapshotRow[], operation: Operation): void {
	let row = rows.find(
		(candidate) =>
			candidate.table === operation.table &&
			candidate.rowId === operation.rowId,
	);
	if (operation.kind === 'deleteRow') {
		if (row) {
			row.deleted = true;
			row.cells = {};
		} else {
			rows.push({
				table: operation.table,
				rowId: operation.rowId,
				deleted: true,
				cells: {},
			});
		}
		return;
	}
	if (row?.deleted) return;
	if (!row) {
		row = {
			table: operation.table,
			rowId: operation.rowId,
			deleted: false,
			cells: {},
		};
		rows.push(row);
	}
	for (const [field, value] of Object.entries(operation.cells)) {
		if (value === null) delete row.cells[field];
		else row.cells[field] = value;
	}
}

function compareRows(left: SnapshotRow, right: SnapshotRow): number {
	return JSON.stringify([left.table, left.rowId]).localeCompare(
		JSON.stringify([right.table, right.rowId]),
	);
}
