import type { PrincipalId } from '@epicenter/identity';
import type {
	BaselineScanRequest,
	BaselineScanResponse,
	EnrollRequest,
	EnrollResponse,
	GrowthDecision,
	SyncRequest,
	SyncResponse,
} from '@epicenter/row-sync';

/** The authenticated server partition selected outside the row-sync protocol. */
export type RecordsPartition = {
	principalId: PrincipalId;
	workspaceId: string;
};

/** Options a deployment resolves before the authority evaluates a request. */
export type RecordsCallOptions = {
	/** Capacity admission for this exchange (ADR-0137); default `allow`. */
	growth?: GrowthDecision;
};

/**
 * The deployment's local capacity resolution for one partition (ADR-0137).
 * `unavailable` means the projection could not be loaded: growth fails
 * closed with a retryable response while reads and deletions proceed.
 * Shared server code never learns plan ids, allowances, or billing concepts.
 */
export type ResolveGrowth = (
	partition: RecordsPartition,
) => Promise<GrowthDecision | 'unavailable'>;

/** Portable authority backend used by HTTP routes and runtime-specific stores. */
export type Records = {
	enroll(
		partition: RecordsPartition,
		request: EnrollRequest,
		options?: RecordsCallOptions,
	): Promise<EnrollResponse>;
	sync(
		partition: RecordsPartition,
		request: SyncRequest,
		options?: RecordsCallOptions,
	): Promise<SyncResponse>;
	baselineScan(
		partition: RecordsPartition,
		request: BaselineScanRequest,
	): Promise<BaselineScanResponse>;
};
