import { canonicalJson } from '@epicenter/row-sync';
import type { PrincipalId } from '@epicenter/identity';
import { sha256Hex } from '../shared/sha256.js';

export type WorkspaceAccount<TTransport> = {
	/**
	 * Canonical deployment identity for local account-owned storage.
	 *
	 * Today callers pass the deployment base URL. The account handle owns the
	 * eventual tightening to a branded deployment id; runtime callers should not
	 * compose persistence keys themselves.
	 */
	deploymentId: string;
	principalId: PrincipalId;
	transport: TTransport;
};

export function devicePersistenceKey(): string {
	return sha256Hex(canonicalJson({ owner: 'device' }));
}

export function accountPersistenceKey(
	account: Pick<WorkspaceAccount<unknown>, 'deploymentId' | 'principalId'>,
): string {
	return sha256Hex(
		canonicalJson({
			owner: 'account',
			deploymentId: account.deploymentId,
			principalId: account.principalId,
		}),
	);
}
