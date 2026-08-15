import { fromWorkspace } from '@epicenter/svelte';
import { createContext } from 'svelte';
import { reportBackgroundError } from '../report.js';
import type { HoneycrispRuntime } from '../runtime.js';
import {
	createNoteSearchIndex,
	readDocumentText,
} from '../search-index.svelte.js';
import { createFolders } from './folders.svelte.js';
import { createNotes } from './notes.svelte.js';
import { createView } from './view.svelte.js';

/**
 * The reactive Honeycrisp application, for one mounted app generation.
 *
 * The runtime is boot machinery: it opens documents, attaches sync, and owns
 * disposal (ADR-0233). This is the application built on top of it, and the
 * one object the UI consumes. It owns the document-selection policy, the
 * reactive named tables over that document (`fromWorkspace`), Honeycrisp's
 * domain operations (`notes`, `folders`), the body search index, the
 * navigation and filtering state (`view`), and the narrow account and store
 * capabilities the UI actually needs. The raw runtime never crosses this
 * boundary: the account's data is already adapted into `tables`, and what
 * remains of the account is its two capabilities.
 *
 * The document choice lives here, visible once: account notes when this
 * generation has an account, device notes otherwise. The runtime carries no
 * default document, so this line is the whole of the policy, and a Local
 * Drafts feature would build a second object over `runtime.deviceData` in
 * the same way. A page lifetime is one auth generation (ADR-0232), so the
 * choice never changes while this object lives.
 *
 * One instance per mounted app generation, created by the layout's provider
 * and reached through `getHoneycrisp`, never a module-global singleton.
 * Nothing here needs disposing: the adapter's subscriptions are ref-counted
 * to the effects that read them, so they detach when the consuming
 * components unmount, and the search index is plain memory.
 */
export function createHoneycrisp({ runtime }: { runtime: HoneycrispRuntime }) {
	const data = runtime.account?.data ?? runtime.deviceData;
	const workspace = fromWorkspace(data);
	// Honeycrisp's own body index (ADR-0207 keeps prose out of the row, so
	// searching it is the application's job). Reading a note's text is a walk
	// over a type already in memory, so there is no document to open and release
	// and no failure to report.
	const searchIndex = createNoteSearchIndex({
		readText: (noteId) =>
			readDocumentText(workspace.tables.notes.document(noteId)),
		onError: reportBackgroundError,
	});
	const folders = createFolders({ workspace });
	const notes = createNotes({ workspace, searchIndex });
	const view = createView({ folders, notes, searchIndex });

	return {
		tables: workspace.tables,
		folders,
		notes,
		view,
		/**
		 * Storage pressure of the document this generation is showing,
		 * whichever that is. The one store verb the UI reads, exposed narrowly
		 * so the raw store plane stays behind this boundary.
		 */
		pressure: () => data.store.pressure(),
		/**
		 * The account's two capabilities, present exactly when this generation
		 * has one. Its data is not here, because it already is: the tables
		 * above are the chosen document.
		 */
		account:
			runtime.account === undefined
				? undefined
				: {
						syncStatus: runtime.account.syncStatus,
						rebuild: runtime.account.rebuild,
					},
	};
}

export type Honeycrisp = ReturnType<typeof createHoneycrisp>;

export const [getHoneycrisp, setHoneycrisp] = createContext<Honeycrisp>();
