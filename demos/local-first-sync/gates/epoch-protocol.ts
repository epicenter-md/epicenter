import type {
	Cells,
	Operation,
	PushRequest,
	Refusal,
	SnapshotRow,
} from './protocol';

export type IncarnationStatus =
	| 'active'
	| 'frozen'
	| 'preparing'
	| 'superseded';

export type TransformDestination = {
	table: string;
	rowId: 'preserve' | { constant: string };
};

export type TableTransform = {
	sourceTable: string;
	destinations: TransformDestination[];
	fields: Record<string, string | null>;
	defaults?: Cells;
};

export type EpochTransform = {
	fromEpochId: string;
	toEpochId: string;
	tables: TableTransform[];
};

export type BeginTransition = {
	targetIncarnationId: string;
	leaseId: string;
	expiresAt: number;
	transform: EpochTransform;
};

export type TransitionResult =
	| { ok: true }
	| {
			ok: false;
			reason:
				| 'transition-in-progress'
				| 'no-transition'
				| 'wrong-lease'
				| 'lease-expired'
				| 'lease-not-expired'
				| 'baseline-incomplete'
				| 'epoch-mismatch'
				| 'one-to-many-identity'
				| 'many-to-one-identity'
				| 'missing-table-transform'
				| 'target-incarnation-exists';
	  };

export type BuildTransitionResult =
	| { ok: true; complete: boolean }
	| { ok: false; reason: 'no-transition' | 'wrong-lease' | 'lease-expired' };

export type EpochPushResult =
	| { ok: true }
	| {
			ok: false;
			reason: Refusal | 'transition-frozen' | 'actor-sequence-gap';
	  };

export type IncarnationDump = {
	id: string;
	epochId: string;
	status: IncarnationStatus;
	head: number;
	rows: SnapshotRow[];
	actorHighWater: Record<string, number>;
};

export type EpochAuthorityDump = {
	activeIncarnationId: string;
	incarnations: IncarnationDump[];
	transition: null | {
		leaseId: string;
		sourceIncarnationId: string;
		targetIncarnationId: string;
		expiresAt: number;
		nextRowIndex: number;
		totalRows: number;
	};
};

export type ImportPlan = {
	actorId: string;
	operations: Operation[];
};

export type EpochAuthority = {
	push(request: PushRequest): EpochPushResult;
	beginTransition(request: BeginTransition): TransitionResult;
	buildTransition(
		leaseId: string,
		batchSize: number,
		now: number,
	): BuildTransitionResult;
	activate(leaseId: string, now: number): TransitionResult;
	expire(now: number): TransitionResult;
	dump(): EpochAuthorityDump;
};
