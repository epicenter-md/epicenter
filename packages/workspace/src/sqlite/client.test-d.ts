/**
 * SQLite Workspace Client Type Tests
 *
 * Locks fresh-id creation at the public async and batch table boundaries.
 * Callers provide only authored cells, while returned identities retain the
 * brand declared by the table schema.
 */

import { field } from '@epicenter/field';
import type { Brand } from 'wellcrafted/brand';
import {
	type OpenStandaloneWorkspaceOptions as BrowserOpenOptions,
	openStandaloneWorkspace as openBrowserWorkspace,
} from './browser.js';
import {
	type OpenStandaloneWorkspaceOptions as BunOpenOptions,
	openStandaloneWorkspace as openBunWorkspace,
} from './bun.js';
import type {
	AsyncTable,
	AsyncWorkspace,
	WorkspaceServicePort,
	WorkspaceWriteBatch,
} from './client.js';
import { createWorkspaceClient } from './client.js';
import { defineTable, defineWorkspace, type RowFor } from './definition.js';
import type {
	WorkspaceDocumentRuntime,
	WorkspaceDocuments,
} from './document-client.js';
import { document } from './document-format.js';
import type { DocumentReference } from './document-reference.js';

type NoteId = string & Brand<'NoteId'>;
type RecordingId = string & Brand<'RecordingId'>;

const notes = defineTable({
	fields: {
		id: field.string<NoteId>(),
		title: field.string(),
	},
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

const notesWithDocuments = defineTable({
	fields: { id: field.string<NoteId>(), title: field.string() },
	documents: { body: document.plainText },
});
const workspaceWithDocumentsDefinition = defineWorkspace({
	id: 'client-type-test',
	tables: { notes: notesWithDocuments },
});
declare const tableWithDocuments: AsyncTable<
	RowFor<typeof notesWithDocuments>,
	typeof notesWithDocuments.documents,
	WorkspaceDocuments
>;
declare const documents: WorkspaceDocuments;
declare const documentRuntime: WorkspaceDocumentRuntime;
declare const historicalBody: DocumentReference<typeof document.plainText>;
declare const noteId: NoteId;
declare const recordingId: RecordingId;

const currentBody = tableWithDocuments.docs.body.open(noteId);
const previousBody = documents.open(historicalBody, noteId);
const currentReady: Promise<void> = currentBody.whenReady;
const previousReady: Promise<void> = previousBody.whenReady;
type CurrentBodyValue = ReturnType<typeof currentBody.content.read>;
type PreviousBodyValue = ReturnType<typeof previousBody.content.read>;
const currentBodyValue: CurrentBodyValue = 'current';
const previousBodyValue: PreviousBodyValue = 'previous';

tableWithDocuments.docs.body.guid(noteId);
// @ts-expect-error — current table documents retain their owning row-id brand
tableWithDocuments.docs.body.open(recordingId);
// @ts-expect-error — guid derivation retains the same owning row-id brand
tableWithDocuments.docs.body.guid(recordingId);

declare const guidOnlyTable: AsyncTable<
	RowFor<typeof notesWithDocuments>,
	typeof notesWithDocuments.documents
>;
declare const workspaceWithoutDocuments: AsyncWorkspace<{
	notes: typeof notesWithDocuments;
}>;
const noDocuments: undefined = workspaceWithoutDocuments.documents;
guidOnlyTable.docs.body.guid(noteId);
// @ts-expect-error — opening requires a composed document runtime
guidOnlyTable.docs.body.open(noteId);

declare const servicePort: WorkspaceServicePort;
createWorkspaceClient(workspaceWithDocumentsDefinition, servicePort, documents);
// @ts-expect-error — a document-enabled client requires the runtime argument
createWorkspaceClient<{ notes: typeof notesWithDocuments }, WorkspaceDocuments>(
	workspaceWithDocumentsDefinition,
	servicePort,
);

const browserWithDocuments: BrowserOpenOptions<
	undefined,
	WorkspaceDocumentRuntime
> = {
	worker: () => null as never,
	documents: documentRuntime,
	onObserverError() {},
};
// @ts-expect-error — a non-undefined runtime generic makes documents required
const browserMissingDocuments: BrowserOpenOptions<
	undefined,
	WorkspaceDocumentRuntime
> = {
	worker: () => null as never,
	onObserverError() {},
};
const bunWithDocuments: BunOpenOptions<WorkspaceDocumentRuntime> = {
	storage: { kind: 'memory' },
	documents: documentRuntime,
	onObserverError() {},
};
// @ts-expect-error — a non-undefined runtime generic makes documents required
const bunMissingDocuments: BunOpenOptions<WorkspaceDocumentRuntime> = {
	storage: { kind: 'memory' },
	onObserverError() {},
};
const browserOpen = openBrowserWorkspace(workspaceWithDocumentsDefinition, {
	worker: () => null as never,
	documents: documentRuntime,
	onObserverError() {},
});
const inferredBrowserDocuments: WorkspaceDocuments = null as unknown as Awaited<
	typeof browserOpen
>['documents'];
const bunOpen = openBunWorkspace(workspaceWithDocumentsDefinition, {
	storage: { kind: 'memory' },
	documents: documentRuntime,
	onObserverError() {},
});
const inferredBunDocuments: WorkspaceDocuments = null as unknown as Awaited<
	typeof bunOpen
>['documents'];

void currentBody;
void previousBody;
void currentReady;
void previousReady;
void currentBodyValue;
void previousBodyValue;
void noDocuments;
void browserWithDocuments;
void browserMissingDocuments;
void bunWithDocuments;
void bunMissingDocuments;
void inferredBrowserDocuments;
void inferredBunDocuments;
