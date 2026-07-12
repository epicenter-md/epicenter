/**
 * SQLite Workspace Definition Type Tests
 *
 * Locks the row, index, document-layout, and KV nullability inference of the
 * greenfield declaration API. Runtime recognition of the closed field palette
 * is covered separately in `definition.test.ts`.
 */

import { field } from '@epicenter/field';
import { type Static, Type } from 'typebox';
import { nullable } from '../document/nullable.js';
import { defineKv, defineTable, type RowFor } from './definition.js';

const notes = defineTable(
	{
		id: field.string(),
		title: field.string(),
		folderId: nullable(field.string()),
	},
	{
		indexes: [['folderId']],
		docs: { body: 'plainText' },
	},
);

const row: RowFor<typeof notes> = {
	id: 'note-1',
	title: 'Hello',
	folderId: null,
};
const title: string = row.title;
const folderId: string | null = row.folderId;
const docLayout: 'plainText' = notes.options.docs.body;
const indexedColumn: keyof typeof notes.columns = 'folderId';

const enabled = defineKv(field.boolean(), () => true);
const enabledValue: boolean = null as unknown as Static<typeof enabled.schema>;

// @ts-expect-error — every application table requires an id column
defineTable({ title: field.string() });

defineTable(
	{ id: field.string(), title: field.string() },
	{
		// @ts-expect-error — indexes may name only declared columns
		indexes: [['missing']],
	},
);

defineTable(
	{ id: field.string() },
	{
		// @ts-expect-error — application docs have exactly two public layouts
		docs: { body: 'records' },
	},
);

// @ts-expect-error — null is reserved for KV clear, not a stored KV value
defineKv(nullable(field.string()), () => null);

// @ts-expect-error — null-admitting table fields require the explicit nullable wrapper
defineTable({ id: field.string(), payload: field.json(Type.Unknown()) });

defineTable({
	id: field.string(),
	payload: nullable(field.json(Type.Unknown())),
});

void title;
void folderId;
void docLayout;
void indexedColumn;
void enabledValue;
