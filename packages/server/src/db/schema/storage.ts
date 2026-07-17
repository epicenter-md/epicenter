import { bigint, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * One absolute physical-size observation per storage source (ADR-0137).
 * This is the account's source registry and last-observed cache: `workspace`
 * sources record the row authority's `databaseSize`, the `blobs` source the
 * account's absolute listed object bytes. The hosted deployment refreshes
 * and sums these rows when it decides one capability issuance; no request
 * path reads or writes them. Writes always overwrite with the newest
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
