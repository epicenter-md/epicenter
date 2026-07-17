import { eq } from 'drizzle-orm';
import type { Db } from './create-db.js';
import { storageObservation } from './schema/storage.js';

/**
 * Mechanics for the ADR-0137 storage-observation registry. These functions
 * move absolute values; they never learn plan ids, allowances, or prices.
 * The hosted deployment owns the policy that turns the observed sum into a
 * capability-issuance decision.
 */

export type StorageSourceKind = 'workspace' | 'blobs';

export type StorageObservation = {
	sourceKind: StorageSourceKind;
	sourceId: string;
	observedBytes: number;
};

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

/** Every live source observation for one account. */
export async function listStorageObservations(
	db: Db,
	principalId: string,
): Promise<StorageObservation[]> {
	const rows = await db
		.select({
			sourceKind: storageObservation.sourceKind,
			sourceId: storageObservation.sourceId,
			observedBytes: storageObservation.observedBytes,
		})
		.from(storageObservation)
		.where(eq(storageObservation.principalId, principalId));
	return rows.map((row) => ({
		sourceKind: row.sourceKind,
		sourceId: row.sourceId,
		observedBytes: Number(row.observedBytes),
	}));
}
