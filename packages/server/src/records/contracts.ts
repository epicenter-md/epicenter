import type { PrincipalId } from '@epicenter/identity';
import type {
	ActivateCandidateResult,
	CandidateManifest,
	DiscardCandidateResult,
	PullRequest,
	PullResponse,
	PushRequest,
	PushResponse,
	RecordAuthorityOpenRequest,
	RecordAuthorityOpenResult,
	SealCandidateResult,
	SnapshotChunkRequest,
	SnapshotChunkResponse,
	StageCandidateResult,
	UploadCandidateChunkResult,
} from '@epicenter/record-sync';

/** The authenticated server partition selected outside the record-sync protocol. */
export type RecordsPartition = {
	principalId: PrincipalId;
	workspaceId: string;
};

/** Portable authority backend used by HTTP routes and runtime-specific stores. */
export type Records = {
	open(
		partition: RecordsPartition,
		request: RecordAuthorityOpenRequest,
	): Promise<RecordAuthorityOpenResult>;
	push(
		partition: RecordsPartition,
		request: PushRequest,
	): Promise<PushResponse>;
	pull(
		partition: RecordsPartition,
		request: PullRequest,
	): Promise<PullResponse>;
	snapshotChunk(
		partition: RecordsPartition,
		request: SnapshotChunkRequest,
	): Promise<SnapshotChunkResponse>;
	stageCandidate(
		partition: RecordsPartition,
		manifest: CandidateManifest,
	): Promise<StageCandidateResult>;
	uploadCandidateChunk(
		partition: RecordsPartition,
		candidateId: string,
		chunk: import('@epicenter/record-sync').SnapshotChunk,
	): Promise<UploadCandidateChunkResult>;
	sealCandidate(
		partition: RecordsPartition,
		candidateId: string,
	): Promise<SealCandidateResult>;
	activateCandidate(
		partition: RecordsPartition,
		candidateId: string,
	): Promise<ActivateCandidateResult>;
	discardCandidate(
		partition: RecordsPartition,
		candidateId: string,
	): Promise<DiscardCandidateResult>;
};
