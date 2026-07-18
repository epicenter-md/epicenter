import type { PrincipalId } from '@epicenter/identity';
import type {
	AcquireRequest,
	AcquireResponse,
	PullRequest,
	PullResponse,
	PushRequest,
	PushResponse,
} from '@epicenter/row-sync';

/** The authenticated partition selected outside the row-sync protocol. */
export type CurrentStateRecordsPartition = {
	principalId: PrincipalId;
	workspaceId: string;
};

/** Portable current-state authority used by HTTP routes and storage backends. */
export type CurrentStateRecords = {
	deleteWorkspace(partition: CurrentStateRecordsPartition): Promise<void>;
	hasReplica(
		partition: CurrentStateRecordsPartition,
		replicaId: string,
	): Promise<boolean>;
	push(
		partition: CurrentStateRecordsPartition,
		request: PushRequest,
	): Promise<PushResponse>;
	pull(
		partition: CurrentStateRecordsPartition,
		request: PullRequest,
	): Promise<PullResponse>;
	acquire(
		partition: CurrentStateRecordsPartition,
		request: AcquireRequest,
	): Promise<AcquireResponse>;
};
