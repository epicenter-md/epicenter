import { field } from '@epicenter/field';
import type { SqliteDatabase } from '@epicenter/sqlite';
import { createCanonicalRowsView } from './canonical-rows.js';
import { createCanonicalStore } from './canonical-store.js';
import { defineTable } from './lens-definition.js';

const definitions = {
	notes: defineTable({
		fields: { title: field.string(), archived: field.boolean() },
		optional: ['archived'],
	}),
};

declare const sqlite: SqliteDatabase;
const notes = createCanonicalRowsView(createCanonicalStore(sqlite), definitions)
	.tables.notes;
const row = notes.create({ title: 'typed' });
notes.update(row.id, { archived: undefined });

// @ts-expect-error identity is allocated by the runtime
notes.create({ id: 'manual', title: 'typed' });
// @ts-expect-error required fields cannot be unset
notes.update(row.id, { title: undefined });
// @ts-expect-error updates accept declared fields only
notes.update(row.id, { future: true });
