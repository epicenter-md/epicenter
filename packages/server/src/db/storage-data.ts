import { eq, sql } from 'drizzle-orm';
import type { Db } from './create-db.js';
import { storageAccountProjection, storageObservation } from './schema/storage.js';

/**
 * Mechanics for the ADR-0137 storage tables. These functions move absolute
 * values; they never learn plan ids, allowances, or prices. The hosted
 * deployment owns the policy that decides `growthAllowed` and injects the
 * result through the records route's growth seam.
 */

export type StorageSourceKind = 'workspace' | 'blobs';

export async function upsertStorageObservation(
	db: Db,
	observation: {
		principalId: string;
		sourceKind: StorageSourceKind;
		sourceId: string;
		observedBytes: number;
	},
): Promise<void> {
	await db
		.insert(storageObservation)
		.values({ ...observation, observedAt: new Date() })
		.onConflictDoUpdate({
			target: [
				storageObservation.principalId,
				storageObservation.sourceKind,
				storageObservation.sourceId,
			],
			set: {
				observedBytes: observation.observedBytes,
				observedAt: new Date(),
			},
		});
}

/** Remove one source's observation after its authoritative deletion. */
export async function deleteStorageObservation(
	db: Db,
	source: {
		principalId: string;
		sourceKind: StorageSourceKind;
		sourceId: string;
	},
): Promise<void> {
	await db
		.delete(storageObservation)
		.where(
			sql`${storageObservation.principalId} = ${source.principalId}
			 and ${storageObservation.sourceKind} = ${source.sourceKind}
			 and ${storageObservation.sourceId} = ${source.sourceId}`,
		);
}

/** The reconciled sum of the newest absolute observation per live source. */
export async function sumStorageObservations(
	db: Db,
	principalId: string,
): Promise<number> {
	const [row] = await db
		.select({
			total: sql<number>`coalesce(sum(${storageObservation.observedBytes}), 0)`,
		})
		.from(storageObservation)
		.where(eq(storageObservation.principalId, principalId));
	return Number(row?.total ?? 0);
}

export type StorageProjection = {
	observedBytes: number;
	growthAllowed: boolean;
	policyObservedAt: Date;
	usageReconciledAt: Date | null;
};

export async function readStorageProjection(
	db: Db,
	principalId: string,
): Promise<StorageProjection | undefined> {
	const [row] = await db
		.select()
		.from(storageAccountProjection)
		.where(eq(storageAccountProjection.principalId, principalId));
	return row
		? {
				observedBytes: Number(row.observedBytes),
				growthAllowed: row.growthAllowed,
				policyObservedAt: row.policyObservedAt,
				usageReconciledAt: row.usageReconciledAt,
			}
		: undefined;
}

export async function writeStorageProjection(
	db: Db,
	projection: {
		principalId: string;
		observedBytes: number;
		growthAllowed: boolean;
		usageReconciledAt?: Date | null;
	},
): Promise<void> {
	await db
		.insert(storageAccountProjection)
		.values({
			principalId: projection.principalId,
			observedBytes: projection.observedBytes,
			growthAllowed: projection.growthAllowed,
			policyObservedAt: new Date(),
			usageReconciledAt: projection.usageReconciledAt ?? null,
		})
		.onConflictDoUpdate({
			target: storageAccountProjection.principalId,
			set: {
				observedBytes: projection.observedBytes,
				growthAllowed: projection.growthAllowed,
				policyObservedAt: new Date(),
				...(projection.usageReconciledAt === undefined
					? {}
					: { usageReconciledAt: projection.usageReconciledAt }),
			},
		});
}
