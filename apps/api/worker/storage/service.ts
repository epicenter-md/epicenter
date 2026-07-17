/**
 * Hosted storage policy (ADR-0137).
 *
 * Epicenter Cloud meters one physical account total: the sum of the latest
 * absolute `databaseSize` observation per hosted workspace plus the absolute
 * hosted blob bytes. This module owns the Cloud side of that policy: it
 * records observations, recomputes the per-account projection against the
 * active catalog allowance, and answers the records route's deployment-
 * neutral growth question. Request paths read the projection row only; the
 * billing provider is never on a request path. An absent projection row is a
 * new account: zero observed bytes, growth allowed.
 */

import type { PrincipalId } from '@epicenter/identity';
import type { Db, RecordsPartition } from '@epicenter/server';
import {
	readStorageProjection,
	sumStorageObservations,
	upsertStorageObservation,
	writeStorageProjection,
} from '@epicenter/server';
import { extractErrorMessage } from 'wellcrafted/error';
import { createAutumnClient } from '../billing/autumn.js';
import { getPlan, PLAN_IDS, type PlanId } from '../billing/catalog.js';

/** Resolve the account's included storage bytes from the active plan. */
async function resolveIncludedBytes(
	env: Cloudflare.Env,
	principal: { id: PrincipalId; email?: string },
): Promise<number> {
	const autumn = createAutumnClient(env);
	const customer = await autumn.customers.getOrCreate({
		customerId: principal.id,
		...(principal.email === undefined ? {} : { email: principal.email }),
	});
	const mainSubscription =
		customer.subscriptions.find((subscription) => !subscription.addOn) ?? null;
	const planId = (mainSubscription?.planId ?? PLAN_IDS.free) as PlanId;
	const plan = getPlan(planId);
	return plan && plan.kind === 'subscription' ? plan.storage.includedBytes : 0;
}

export function createStorageService({
	db,
	env,
}: {
	db: Db;
	env: Cloudflare.Env;
}) {
	return {
		/**
		 * Record one workspace authority's absolute size and recompute the
		 * account projection. Runs in the after-response lifetime; a provider
		 * or database failure leaves the previous projection standing and is
		 * reported at its source.
		 */
		async observeWorkspace(
			partition: RecordsPartition,
			observedBytes: number,
			principalEmail?: string,
		): Promise<void> {
			try {
				await upsertStorageObservation(db, {
					principalId: partition.principalId,
					sourceKind: 'workspace',
					sourceId: partition.workspaceId,
					observedBytes,
				});
				const total = await sumStorageObservations(db, partition.principalId);
				const includedBytes = await resolveIncludedBytes(env, {
					id: partition.principalId,
					...(principalEmail === undefined ? {} : { email: principalEmail }),
				});
				await writeStorageProjection(db, {
					principalId: partition.principalId,
					observedBytes: total,
					growthAllowed: total < includedBytes,
				});
			} catch (cause) {
				console.error(
					`[storage] observation for ${partition.principalId}/${partition.workspaceId} failed: ${extractErrorMessage(cause)}`,
				);
			}
		},

		/**
		 * The records route's growth decision (ADR-0137). An absent projection
		 * row is a new account and may grow; a database failure resolves
		 * `unavailable`, which fails only growth, closed and retryably.
		 */
		async resolveGrowth(
			partition: RecordsPartition,
		): Promise<'allow' | 'delete-only' | 'unavailable'> {
			try {
				const projection = await readStorageProjection(
					db,
					partition.principalId,
				);
				if (!projection) return 'allow';
				return projection.growthAllowed ? 'allow' : 'delete-only';
			} catch {
				return 'unavailable';
			}
		},
	};
}
