/**
 * Opensidian's wiring of the shared first-sign-in migration
 * (`@epicenter/app-shell/sign-in-migration`): the local-source opener and the
 * words are app-side; the probe, Add, Delete, Keep, and derived child-doc
 * phases are the kit's.
 */

import { createSignInMigration } from '@epicenter/app-shell/sign-in-migration';
import { attachIndexedDb } from '@epicenter/workspace';
import { opensidianWorkspace } from 'opensidian';
import { opensidian } from '$lib/opensidian';
import { auth } from '$lib/platform/auth';

/**
 * Open a throwaway handle to the signed-out plaintext local doc (the migration
 * source). This opens the same `epicenter-opensidian` IndexedDB the
 * signed-out app uses; the principal doc's storage is partitioned, so this never
 * collides with the active synced doc. `dispose()` tears down the connection
 * without deleting data (`clearLocal` does the deletion).
 */
function openLocalSource() {
	const workspace = opensidianWorkspace.create();
	const idb = attachIndexedDb(workspace.ydoc);
	return {
		tables: workspace.tables,
		whenLoaded: idb.whenLoaded,
		clearLocal: idb.clearLocal,
		dispose: () => workspace.ydoc.destroy(),
	};
}

/**
 * Human phrase for what is staged locally, e.g. "3 files".
 */
function describeLocalContents(counts: Record<string, number>): string {
	const files = counts.files ?? 0;
	return files > 0 ? `${files} file${files === 1 ? '' : 's'}` : 'data';
}

export const signInMigration = createSignInMigration({
	auth,
	openLocalSource,
	target: opensidian,
	describe: describeLocalContents,
	errorNoun: 'files',
});
