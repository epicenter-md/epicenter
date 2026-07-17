import type { PrincipalId } from '@epicenter/identity';
import type {
	SnapshotChunkRequest,
	SnapshotChunkResponse,
	SyncRequest,
	SyncResponse,
} from '@epicenter/record-sync';

/** The authenticated server partition selected outside the record-sync protocol. */
export type RecordsPartition = {
	principalId: PrincipalId;
	workspaceId: string;
};

/** Portable authority backend used by HTTP routes and runtime-specific stores. */
export type Records = {
	sync(
		partition: RecordsPartition,
		request: SyncRequest,
	): Promise<SyncResponse>;
	snapshotChunk(
		partition: RecordsPartition,
		request: SnapshotChunkRequest,
	): Promise<SnapshotChunkResponse>;
};
