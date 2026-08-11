import { createContext } from 'svelte';
import { type HoneycrispData, NOTE_BODY } from '@epicenter/honeycrisp';
import { reportBackgroundError } from '../../lib/report.js';
import type { HoneycrispRuntime } from '../../lib/runtime.js';
import {
	createNoteSearchIndex,
	readDocumentText,
} from '../../lib/search-index.svelte.js';
import { createFolders } from './folders.svelte.js';
import { createNotes } from './notes.svelte.js';
import { createView } from './view.svelte.js';

export function createHoneycrispState({ db }: { db: HoneycrispData }) {
	const folders = createFolders({ db });
	// Honeycrisp's own body index (ADR-0207 keeps prose out of the row, so
	// searching it is the application's job). Reading a note's text is now a walk
	// over a type already in memory, so there is no document to open and release
	// and no failure to report.
	const searchIndex = createNoteSearchIndex({
		readText: (noteId) => readDocumentText(db.tables.notes.document(noteId)),
		onError: reportBackgroundError,
	});
	const notes = createNotes({ db, searchIndex });
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

/**
 * The notes surface: one document, deliberately chosen, and the UI state
 * bound to it.
 *
 * The runtime carries no default document (ADR-0233), so the surface root is
 * where the choice lives: the notes surface edits the account's notes when
 * this generation has an account, and the device's otherwise, and a future
 * Local Drafts surface writes `runtime.deviceData` in the same position. The
 * state is document-bound, which is why the surface owns it instead of the
 * runtime: two open documents would mean two states, never one global one.
 */
export type NotesSurface = {
	/** The document this surface reads and edits. */
	data: HoneycrispRuntime['deviceData'];
	state: ReturnType<typeof createHoneycrispState>;
};

export const [getNotesSurface, setNotesSurface] = createContext<NotesSurface>();

export { NOTE_BODY };
