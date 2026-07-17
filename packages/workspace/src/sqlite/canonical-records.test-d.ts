import { field } from '@epicenter/field';
import type { RowSyncSqlite } from '@epicenter/row-sync';
import { createCanonicalRecords } from './canonical-records.js';
import { defineTable } from './lens-definition.js';

const definitions = {
	notes: defineTable({
		fields: { title: field.string(), archived: field.boolean() },
		optional: ['archived'],
	}),
};

declare const sqlite: RowSyncSqlite;
const notes = createCanonicalRecords(sqlite, definitions).tables.notes;
const row = notes.create({ title: 'typed' });
notes.update(row.id, { archived: undefined });

// @ts-expect-error identity is allocated by the runtime
notes.create({ id: 'manual', title: 'typed' });
// @ts-expect-error required fields cannot be unset
notes.update(row.id, { title: undefined });
// @ts-expect-error updates accept declared fields only
notes.update(row.id, { future: true });
