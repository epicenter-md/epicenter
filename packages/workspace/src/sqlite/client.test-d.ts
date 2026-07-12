/**
 * SQLite Workspace Client Type Tests
 *
 * Locks fresh-id creation at the public async and batch table boundaries.
 * Callers provide only authored cells, while returned identities retain the
 * brand declared by the table schema.
 */

import { field } from '@epicenter/field';
import type { Brand } from 'wellcrafted/brand';
import type { AsyncTable, WorkspaceWriteBatch } from './client.js';
import { defineTable, type RowFor } from './definition.js';

type NoteId = string & Brand<'NoteId'>;

const notes = defineTable({
	id: field.string<NoteId>(),
	title: field.string(),
});
type Note = RowFor<typeof notes>;

declare const table: AsyncTable<Note>;
declare const batch: WorkspaceWriteBatch<{ notes: typeof notes }>;

const created: Promise<Note> = table.create({ title: 'Created' });
const allocatedId: NoteId = batch.tables.notes.create({ title: 'Batched' });
const existing = null as unknown as Note;

// @ts-expect-error — callers cannot preserve or choose a row id
table.create({ id: 'caller-chosen' as NoteId, title: 'Rejected' });

// @ts-expect-error — an existing full row is not a valid create input
table.create(existing);

// @ts-expect-error — transaction builders also own id allocation
batch.tables.notes.create(existing);

void created;
void allocatedId;
