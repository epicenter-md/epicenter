/**
 * SQLite Workspace Definition Type Tests
 *
 * Locks the row, index, document-layout, and KV nullability inference of the
 * greenfield declaration API. Runtime recognition of the closed field palette
 * is covered separately in `definition.test.ts`.
 */

import { field } from '@epicenter/field';
import { type Static, Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import { nullable } from '../document/nullable.js';
import { defineKv, defineTable, type RowFor } from './definition.js';

type NoteId = string & Brand<'NoteId'>;

const notes = defineTable(
	{
		id: field.string<NoteId>(),
		title: field.string(),
		folderId: nullable(field.string()),
	},
	{
		indexes: [['folderId']],
		docs: { body: 'plainText' },
	},
);

const row: RowFor<typeof notes> = {
	id: 'note-1' as NoteId,
	title: 'Hello',
	folderId: null,
};
const title: string = row.title;
const noteId: NoteId = row.id;
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

// Nullable KV is allowed: the preference plane never rides the record wire,
// so null is an ordinary stored preference (ADR-0124).
const lastFolder = defineKv(nullable(field.string()), () => null);
const lastFolderValue: string | null = null as unknown as Static<
	typeof lastFolder.schema
>;

// @ts-expect-error — null-admitting table fields require the explicit nullable wrapper
defineTable({ id: field.string(), payload: field.json(Type.Unknown()) });

defineTable({
	id: field.string(),
	payload: nullable(field.json(Type.Unknown())),
});

void title;
void noteId;
void folderId;
void docLayout;
void indexedColumn;
void enabledValue;
void lastFolderValue;
