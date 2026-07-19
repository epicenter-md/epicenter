import type { PrincipalId } from '@epicenter/identity';
import { canonicalJson, sha256Hex } from '@epicenter/row-sync';

export const ACCOUNT_KEY_DERIVATION = 'sha256-canonical-json-v1' as const;

export type WorkspaceAccount<TTransport> = {
	/**
	 * Canonical deployment identity for local account-owned storage.
	 *
	 * Today callers pass the deployment base URL; `accountStorageIdentity`
	 * normalizes it once, so formatting variants of the same URL resolve to the
	 * same persistence identity. The account handle owns the eventual tightening
	 * to a branded deployment id; runtime callers should not compose persistence
	 * keys themselves.
	 */
	deploymentId: string;
	principalId: PrincipalId;
	transport: TTransport;
};

/** Opaque IndexedDB owner key for unsigned browser persistence. */
export function deviceBrowserPersistenceKey(): string {
	return sha256Hex(canonicalJson({ owner: 'device' }));
}

/** Opaque IndexedDB owner key for one authenticated browser account. */
export function accountBrowserPersistenceKey(
	account: Pick<WorkspaceAccount<unknown>, 'deploymentId' | 'principalId'>,
): string {
	return accountStorageIdentity(account).key;
}

export function accountStorageIdentity(
	account: Pick<WorkspaceAccount<unknown>, 'deploymentId' | 'principalId'>,
): {
	key: string;
	witness: {
		formatVersion: 1;
		keyDerivation: typeof ACCOUNT_KEY_DERIVATION;
		deploymentId: string;
		principalId: PrincipalId;
	};
} {
	const deploymentId = canonicalDeploymentId(account.deploymentId);
	const identity = {
		owner: 'account',
		deploymentId,
		principalId: account.principalId,
	} as const;
	return {
		key: sha256Hex(canonicalJson(identity)),
		witness: {
			formatVersion: 1,
			keyDerivation: ACCOUNT_KEY_DERIVATION,
			deploymentId,
			principalId: account.principalId,
		},
	};
}

/**
 * Normalize deployment identity once (ADR-0138) so formatting variants of the
 * same deployment URL cannot fork account persistence. The trailing slash makes
 * origin-only and path-prefixed deployments each canonical.
 */
function canonicalDeploymentId(deploymentId: string): string {
	const href = new URL(deploymentId).href;
	return href.endsWith('/') ? href : `${href}/`;
}
