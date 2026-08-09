import { type HoneycrispData, NOTE_BODY } from '@epicenter/honeycrisp';
import {
	createNoteSearchIndex,
	readDocumentText,
} from '../../lib/search-index.svelte.js';
import { createFolders } from './folders.svelte.js';
import { createNotes } from './notes.svelte.js';
import { createView } from './view.svelte.js';

export function createHoneycrispState({
	db,
	reportBackgroundError,
}: {
	db: HoneycrispData;
	reportBackgroundError(cause: unknown): void;
}) {
	const folders = createFolders({ db, reportBackgroundError });
	// Honeycrisp's own body index (ADR-0207 keeps prose out of the row, so
	// searching it is the application's job). Reading a note's text is now a walk
	// over a type already in memory, so there is no document to open and release
	// and no failure to report.
	const searchIndex = createNoteSearchIndex({
		readText: (noteId) => readDocumentText(db.notes.document(noteId)),
		onError: reportBackgroundError,
	});
	const notes = createNotes({ db, searchIndex, reportBackgroundError });
	const view = createView({ folders, notes, searchIndex });

	return {
		folders,
		notes,
		view,
		[Symbol.dispose]() {
			notes[Symbol.dispose]();
			folders[Symbol.dispose]();
			view[Symbol.dispose]();
		},
	};
}

export { NOTE_BODY };
