import { field } from '@epicenter/field';
import type {
	ApplicationKv,
	ApplicationTable,
	AsyncKv,
	AsyncTable,
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

declare const asyncKv: AsyncKv<typeof kvDefinitions>;
const asyncTheme = fromKv(asyncKv, 'theme');
const asyncCurrentTheme: 'light' | 'dark' | undefined = asyncTheme.current;
const themeWrite: Promise<void> = asyncTheme.set('dark');
const themeClear: Promise<void> = asyncTheme.clear();
const themeReady: Promise<void> = asyncTheme.whenReady;
// @ts-expect-error — async authoritative writes cannot hide a Promise in assignment
asyncTheme.current = 'light';
// @ts-expect-error — the selected key still controls the async write value
asyncTheme.set(1);

declare const asyncNotes: AsyncTable<Note>;
const asyncNoteView = fromTable(asyncNotes);
const asyncNotesList: readonly Note[] = asyncNoteView.all;
const asyncNote: Note | undefined = asyncNoteView.byId('note-1');
const notesReady: Promise<void> = asyncNoteView.whenReady;

void asyncCurrentTheme;
void themeWrite;
void themeClear;
void themeReady;
void asyncNotesList;
void asyncNote;
void notesReady;
