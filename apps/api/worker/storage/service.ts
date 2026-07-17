/**
 * Hosted storage policy (ADR-0137).
 *
 * Epicenter Cloud meters one physical account total: the sum of the latest
 * absolute `databaseSize` observation per hosted workspace plus the absolute
 * hosted blob bytes. This module owns the Cloud side of that policy at its
 * one decision point: capability issuance. When Cloud is about to create a
 * new storage-producing capability (today: a replica enrollment, which also
 * covers first contact with a new workspace), it refreshes the account's
 * workspace observations from the authorities, sums them with any blob
 * observation, resolves the active plan allowance, and admits or refuses.
 * Synchronization never consults storage state, and no per-exchange
 * observation, projection row, or billing call exists (ADR-0131/0137).
 */

import type { PrincipalId } from '@epicenter/identity';
import type { Db, RecordsPartition } from '@epicenter/server';
import {
	listStorageObservations,
	readWorkspaceDatabaseSize,
	upsertStorageObservation,
} from '@epicenter/server';
import { extractErrorMessage } from 'wellcrafted/error';
import { createAutumnClient } from '../billing/autumn.js';
import { getPlan, PLAN_IDS, type PlanId } from '../billing/catalog.js';

/** Resolve the account's included storage bytes from the active plan. */
async function resolveIncludedBytes(
	env: Cloudflare.Env,
	principalId: PrincipalId,
): Promise<number> {
	const autumn = createAutumnClient(env);
	const customer = await autumn.customers.getOrCreate({
		customerId: principalId,
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
		 * Decide one enrollment (ADR-0137). Reads every observed workspace
		 * authority's current absolute size plus the target workspace's,
		 * overwrites the observation registry with those absolutes, and
		 * compares the account total against the active plan allowance.
		 * Failure to decide returns `unavailable`: enrollment fails closed
		 * and retryably while reads, deletions, and synchronization for
		 * already-enrolled replicas continue untouched.
		 */
		async admitEnrollment(
			partition: RecordsPartition,
		): Promise<'admit' | 'refuse' | 'unavailable'> {
			try {
				const observations = await listStorageObservations(
					db,
					partition.principalId,
				);
				const workspaceIds = new Set(
					observations
						.filter((observation) => observation.sourceKind === 'workspace')
						.map((observation) => observation.sourceId),
				);
				workspaceIds.add(partition.workspaceId);
				let total = observations
					.filter((observation) => observation.sourceKind === 'blobs')
					.reduce((sum, observation) => sum + observation.observedBytes, 0);
				for (const workspaceId of workspaceIds) {
					const observedBytes = await readWorkspaceDatabaseSize(env.RECORDS, {
						principalId: partition.principalId,
						workspaceId,
					});
					await upsertStorageObservation(db, {
						principalId: partition.principalId,
						sourceKind: 'workspace',
						sourceId: workspaceId,
						observedBytes,
					});
					total += observedBytes;
				}
				const includedBytes = await resolveIncludedBytes(
					env,
					partition.principalId,
				);
				return total < includedBytes ? 'admit' : 'refuse';
			} catch (cause) {
				console.error(
					`[storage] enrollment admission for ${partition.principalId}/${partition.workspaceId} failed: ${extractErrorMessage(cause)}`,
				);
				return 'unavailable';
			}
		},
	};
}
