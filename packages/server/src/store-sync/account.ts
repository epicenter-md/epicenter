/**
 * Deleting one account's stored data, across every application it has.
 *
 * A store authority is per (principal, application namespace), so this is a
 * loop where the superseded stack had one call. That is the cost of ADR-0225's
 * partitioning, and it buys the thing that made it necessary: two applications
 * never share a log whose positions neither can read past.
 */
import type { PrincipalId } from '@epicenter/identity';

import { DELETABLE_NAMESPACES, storeAuthorityName } from './route.js';

type DeletableStoreNamespace = {
	idFromName(name: string): unknown;
	get(id: unknown): { deleteStore(): Promise<void> };
};

export function createDurableObjectAccountStores(
	namespace: DeletableStoreNamespace,
) {
	return {
		authority(principalId: PrincipalId) {
			return {
				/**
				 * Delete every namespace this deployment knows about.
				 *
				 * Sequential rather than concurrent: a partial failure should leave
				 * the earlier namespaces actually gone rather than an indeterminate
				 * subset, and the caller retries the whole step.
				 */
				async deleteAccount(): Promise<void> {
					for (const application of DELETABLE_NAMESPACES) {
						const name = storeAuthorityName(principalId, application);
						await namespace.get(namespace.idFromName(name)).deleteStore();
					}
				},
			};
		},
	};
}
