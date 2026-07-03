/**
 * Vocab's wiring of the shared first-sign-in migration
 * (`@epicenter/app-shell/sign-in-migration`): the local-source opener and the
 * wording are app-side; the probe, Add, Delete, Keep, and derived child-doc
 * phases are the kit's.
 */

import { createSignInMigration } from '@epicenter/app-shell/sign-in-migration';
import { vocabWorkspace } from '@epicenter/vocab';
import { attachIndexedDb } from '@epicenter/workspace';
import { vocab } from '$lib/vocab';
import { auth } from '$platform/auth';

/**
 * Open a throwaway handle to the signed-out plaintext local doc (the migration
 * source). This opens the same `epicenter-vocab` IndexedDB the signed-out app
 * uses; the principal doc's storage is partitioned, so this never collides with
 * the active synced doc. `dispose()` tears down the connection without
 * deleting data (`clearLocal` does the deletion).
 */
function openLocalSource() {
	const workspace = vocabWorkspace.create();
	const idb = attachIndexedDb(workspace.ydoc);
	return {
		tables: workspace.tables,
		whenLoaded: idb.whenLoaded,
		clearLocal: idb.clearLocal,
		dispose: () => workspace.ydoc.destroy(),
	};
}

/**
 * Human phrase for what is staged locally, e.g. "3 conversations".
 */
function describeLocalContents(counts: Record<string, number>): string {
	const conversations = counts.conversations ?? 0;
	if (conversations === 0) return 'data';
	return `${conversations} conversation${conversations === 1 ? '' : 's'}`;
}

export const signInMigration = createSignInMigration({
	auth,
	openLocalSource,
	target: vocab,
	describe: describeLocalContents,
	errorNoun: 'conversations',
});
