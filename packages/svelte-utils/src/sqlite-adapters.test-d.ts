import { field } from '@epicenter/field';
import type {
	ApplicationKv,
	ApplicationTable,
} from '@epicenter/workspace/sqlite';
import {
	defineKv,
	defineTable,
	type RowFor,
} from '@epicenter/workspace/sqlite';
import { fromKv } from './from-kv.svelte.js';
import { fromTable } from './from-table.svelte.js';

const kvDefinitions = {
	theme: defineKv(
		field.select(['light', 'dark']),
		(): 'light' | 'dark' => 'light',
	),
	count: defineKv(field.integer(), () => 0),
};
declare const kv: ApplicationKv<typeof kvDefinitions>;

const theme = fromKv(kv, 'theme');
const currentTheme: 'light' | 'dark' = theme.current;
theme.current = 'dark';
// @ts-expect-error — the binding preserves the selected KV key's value type
theme.current = 1;
// @ts-expect-error — undeclared KV keys are rejected
fromKv(kv, 'missing');

const notesDefinition = defineTable({
	id: field.string(),
	title: field.string(),
});
type Note = RowFor<typeof notesDefinition>;
declare const notes: ApplicationTable<Note>;

const noteView = fromTable(notes);
const notesList: readonly Note[] = noteView.all;
const note: Note | undefined = noteView.byId('note-1');
// @ts-expect-error — exact-schema SQLite views do not expose Yjs repair buckets
noteView.nonconforming;

void currentTheme;
void notesList;
void note;
