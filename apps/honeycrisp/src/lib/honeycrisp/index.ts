import { fromWorkspace } from '@epicenter/svelte';
import { createContext } from 'svelte';
import type { HoneycrispDatabases } from '../databases.js';
import { createFolders } from './folders.svelte.js';
import { navigation } from './navigation.svelte.js';
import { createNotes } from './notes.svelte.js';
import { createView } from './view.svelte.js';

/**
 * The reactive Honeycrisp application, for one mounted app generation.
 *
 * The databases are boot's yield: opened documents, attached sync, and the
 * disposal that closes them (ADR-0233). This is the application built on top
 * of them, and the one object the UI consumes. It owns the document-selection policy, the
 * reactive named tables over that document (`fromWorkspace`), Honeycrisp's
 * domain operations (`notes`, `folders`), the navigation and filtering state
 * (`view`), and the narrow account and store
 * capabilities the UI actually needs. The raw databases never cross this
 * boundary: the account's data is already adapted into `tables`, and what
 * remains of the account is its two capabilities.
 *
 * The document choice lives here, visible once: account notes when this
 * generation has an account, device notes otherwise. The databases carry no
 * default, so this line is the whole of the policy, and a Local
 * Drafts feature would build a second object over `databases.device` in
 * the same way. A page lifetime is one auth generation (ADR-0232), so the
 * choice never changes while this object lives.
 *
 * One instance per mounted app generation, created by the layout's provider
 * and reached through `getHoneycrisp`, never a module-global singleton.
 * Nothing here needs disposing: the adapter's subscriptions are ref-counted
 * to the effects that read them, so they detach when the consuming
 * components unmount.
 */
export function createHoneycrisp({
	databases,
}: {
	databases: HoneycrispDatabases;
}) {
	const data = databases.account?.data ?? databases.device;
	const workspace = fromWorkspace(data);
	const folders = createFolders({ workspace });
	const notes = createNotes({ workspace });
	const view = createView({ folders, notes });

	return {
		tables: workspace.tables,
		folders,
		notes,
		view,
		/**
		 * Create a note in the folder the user is looking at and open it in the
		 * editor. Lives here rather than on `notes` or `view` because it is the
		 * one command that spans both, and every create surface (⌘N, the list's
		 * + button, the palette) means exactly this composition.
		 */
		createNote(): void {
			const { id } = notes.create(navigation.folderId);
			navigation.selectNote(id);
		},
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
			databases.account === undefined
				? undefined
				: {
						syncStatus: databases.account.syncStatus,
						rebuild: databases.account.rebuild,
					},
	};
}

export type Honeycrisp = ReturnType<typeof createHoneycrisp>;

export const [getHoneycrisp, setHoneycrisp] = createContext<Honeycrisp>();
