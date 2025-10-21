import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { command, query } from '$app/server';
import { InsertEntitiesInputSchema } from '$lib/schemas/entities';
import { type EntityRow, EntityRowSchema, IdSchema } from '$lib/schemas/notes';
import { getVault } from '$lib/server/vaultService';

/**
 * Command: bulk insert into the entity_index adapter tables using the Vault query interface.
 */
export const insertEntities = command(
	InsertEntitiesInputSchema,
	async (input) => {
		const { db, tables } = getVault().getQueryInterface();
		const entitiesTable = tables.entity_index.entity_index_entities;
		const occurrencesTable = tables.entity_index.entity_index_occurrences;

		const entityRows = input.entities.map((e) => ({
			id: e.id,
			name: e.name ?? null,
			type: e.type ?? null,
			description: e.description,
			public_id: e.public_id,
			created_at: new Date(),
		}));

		const occurrenceRows = input.occurrences.map((o) => ({
			id: o.id,
			entity_id: o.entity_id,
			source_adapter_id: o.source_adapter_id,
			source_table_name: o.source_table_name,
			source_pk_json: o.source_pk_json,
			discovered_at: new Date(),
		}));

		// Insert entities with conflict-ignore
		if (entityRows.length > 0)
			await db.insert(entitiesTable).values(entityRows).onConflictDoNothing();

		// Insert occurrences with conflict-ignore (by PK) when supported
		if (occurrenceRows.length > 0)
			await db
				.insert(occurrencesTable)
				.values(occurrenceRows)
				.onConflictDoNothing();

		return {
			ok: true as const,
			inserted: {
				entities: entityRows.length,
				occurrences: occurrenceRows.length,
			},
		};
	},
);

/**
 * Query: list entities for selection in the "new note" form.
 */
export const getEntities = query(async () => {
	const { db, tables } = getVault().getQueryInterface();

	const entitiesTable = tables.entity_index.entity_index_entities;

	const rows = await db.select().from(entitiesTable);

	return rows;
});

/**
 * Query: get a single entity by ID.
 */
export const getEntityById = query(IdSchema, async ({ id }) => {
	const { db, tables } = getVault().getQueryInterface();

	const entitiesTable = tables.entity_index.entity_index_entities;

	const row = await db
		.select()
		.from(entitiesTable)
		.where(eq(entitiesTable.id, id))
		.limit(1)
		.get();

	if (!row) return error(404, 'entity not found');

	return EntityRowSchema({
		id: row.id,
		name: row.name,
		type: row.type,
	}) as EntityRow;
});
