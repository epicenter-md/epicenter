import type { HoneycrispData } from '@epicenter/honeycrisp';
import {
	createNoteSearchIndex,
	readDocumentText,
} from '../../lib/search-index.svelte.js';
import { createFolders } from './folders.svelte.js';
import { createNotes } from './notes.svelte.js';
import { createView } from './view.svelte.js';

export function createHoneycrispState({
	honeycrisp,
	reportBackgroundError,
}: {
	honeycrisp: HoneycrispData;
	reportBackgroundError(cause: unknown): void;
}) {
	let notes!: ReturnType<typeof createNotes>;
	const folders = createFolders({
		honeycrisp,
		refreshNotes: () => notes.refresh(),
	});
	// Honeycrisp's own body index (ADR-0207 keeps prose out of the row, so
	// searching it is the application's job). One document open at a time, each
	// released as soon as its text is read.
	const searchIndex = createNoteSearchIndex({
		openDocumentText: async (noteId) => {
			await using document = await honeycrisp.notes.openDocument(noteId);
			return readDocumentText(document);
		},
		onError: reportBackgroundError,
	});
	notes = createNotes({ folders, honeycrisp, searchIndex });
	const view = createView({ folders, notes, searchIndex });

	const refresh = () => Promise.all([folders.refresh(), notes.refresh()]);
	const stopFolders = honeycrisp.folders.subscribe(() => {
		void folders.refresh().catch(reportBackgroundError);
	});
	const stopNotes = honeycrisp.notes.subscribe(() => {
		void notes.refresh().catch(reportBackgroundError);
	});
	const whenReady = refresh();

	return {
		folders,
		notes,
		view,
		whenReady,
		[Symbol.dispose]() {
			stopFolders();
			stopNotes();
			view[Symbol.dispose]();
		},
	};
}
