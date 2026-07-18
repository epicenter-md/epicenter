import {
	bigint,
	pgTable,
	primaryKey,
	text,
	timestamp,
} from 'drizzle-orm/pg-core';

/**
 * One absolute physical-size observation per storage source (ADR-0137).
 * This is the account's source registry and last-observed cache. Zero-byte
 * `workspace` rows register logical workspace ids, `structured` records the
 * account authority's one absolute `databaseSize`, and `blobs` records the
 * account's absolute listed object bytes. No synchronization exchange reads or
 * writes these rows.
 * Writes always overwrite with the newest absolute value; nothing accumulates
 * deltas. A workspace enters the storage principal's registry before its first
 * replica is minted and leaves only when its authority is deleted, never when a
 * grant changes or time elapses.
 */
export const storageObservation = pgTable(
	'storage_observation',
	{
		principalId: text('principal_id').notNull(),
		sourceKind: text('source_kind', {
			enum: ['workspace', 'structured', 'blobs'],
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
