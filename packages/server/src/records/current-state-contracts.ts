import type { PrincipalId } from '@epicenter/identity';
import type {
	AcquireRequest,
	AcquireResponse,
	PullRequest,
	PullResponse,
	PushRequest,
	PushResponse,
	RowAddress,
} from '@epicenter/row-sync';

/**
 * One principal's account authority (ADR-0145): every scalar operation and
 * every document socket enters through this handle, with `workspaceId` as an
 * ordinary operation argument, never part of the authority address.
 */
export type AccountAuthority = {
	hasReplica(workspaceId: string, replicaId: string): Promise<boolean>;
	push(workspaceId: string, request: PushRequest): Promise<PushResponse>;
	pull(workspaceId: string, request: PullRequest): Promise<PullResponse>;
	acquire(
		workspaceId: string,
		request: AcquireRequest,
	): Promise<AcquireResponse>;
	deleteWorkspace(workspaceId: string): Promise<void>;
	/** This authority's absolute physical SQLite size in bytes. */
	databaseSize(): Promise<number>;
	acceptDocumentUpgrade(input: {
		workspaceId: string;
		address: RowAddress;
		authorizationExpiresAt: number;
		request: Request;
	}): Response | Promise<Response>;
};

/** The one route-facing authority locator each deployment binds. */
export type AccountAuthorities = {
	authority(principalId: PrincipalId): AccountAuthority;
	/**
	 * Accept-then-close so browsers can read the close code. Transport policy,
	 * not authority behavior: rejection happens when no principal was resolved.
	 */
	rejectDocumentUpgrade(input: {
		request: Request;
		code: number;
		reason: string;
	}): Response | Promise<Response>;
};
