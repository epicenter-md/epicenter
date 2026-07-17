import { bigint, boolean, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * One absolute physical-size observation per storage source (ADR-0137).
 * `workspace` sources report the row authority's `databaseSize` after a
 * completed request; the `blobs` source reports the account's absolute
 * listed object bytes. Reconciliation always overwrites with the newest
 * absolute value; nothing accumulates deltas. Rows leave only when their
 * source is authoritatively deleted, never on elapsed time.
 */
export const storageObservation = pgTable(
	'storage_observation',
	{
		principalId: text('principal_id').notNull(),
		sourceKind: text('source_kind', {
			enum: ['workspace', 'blobs'],
		}).notNull(),
		sourceId: text('source_id').notNull(),
		observedBytes: bigint('observed_bytes', { mode: 'number' }).notNull(),
		observedAt: timestamp('observed_at').defaultNow().notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.principalId, table.sourceKind, table.sourceId],
		}),
	],
);

/**
 * The one locally projected growth decision per account (ADR-0137).
 * `observedBytes` is the reconciled sum of the newest observation per live
 * source; `growthAllowed` resolves that sum against the active catalog
 * allowance. Request paths consume this row and never call the billing
 * provider; reads and deletions never depend on it.
 */
export const storageAccountProjection = pgTable('storage_account_projection', {
	principalId: text('principal_id').primaryKey(),
	observedBytes: bigint('observed_bytes', { mode: 'number' }).notNull(),
	growthAllowed: boolean('growth_allowed').notNull(),
	/** When the active plan policy was last resolved into this row. */
	policyObservedAt: timestamp('policy_observed_at').defaultNow().notNull(),
	/** When usage was last pushed to the billing provider; null = pending. */
	usageReconciledAt: timestamp('usage_reconciled_at'),
});
