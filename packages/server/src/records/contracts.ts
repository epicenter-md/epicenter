import type { PrincipalId } from '@epicenter/identity';
import type {
	BaselineScanRequest,
	BaselineScanResponse,
	EnrollRequest,
	EnrollResponse,
	SyncRequest,
	SyncResponse,
} from '@epicenter/row-sync';

/** The authenticated server partition selected outside the row-sync protocol. */
export type RecordsPartition = {
	principalId: PrincipalId;
	workspaceId: string;
};


/** Portable authority backend used by HTTP routes and runtime-specific stores. */
export type Records = {
	enroll(
		partition: RecordsPartition,
		request: EnrollRequest,
	): Promise<EnrollResponse>;
	sync(
		partition: RecordsPartition,
		request: SyncRequest,
	): Promise<SyncResponse>;
	baselineScan(
		partition: RecordsPartition,
		request: BaselineScanRequest,
	): Promise<BaselineScanResponse>;
};
