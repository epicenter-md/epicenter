/**
 * Whispering's wiring of the shared first-sign-in migration
 * (`@epicenter/app-shell/sign-in-migration`): the local-source opener and the
 * words are app-side; the probe / Add / Delete / Keep mechanics are shared.
 */

import { createSignInMigration } from '@epicenter/app-shell/sign-in-migration';
import { attachIndexedDb } from '@epicenter/workspace';
import { environment } from '#environment';
import { whispering } from '$lib/workspace/active';
import { defineWhispering } from '$lib/workspace';

/**
 * Open a throwaway handle to the signed-out plaintext local doc (the migration
 * source). This opens the same `epicenter-whispering` IndexedDB the
 * signed-out app uses; the principal doc's storage is partitioned, so this never
 * collides with the active synced doc. `dispose()` tears down the connection
 * without deleting data (`clearLocal` does the deletion). The transcription
 * service default is irrelevant here: only table rows are copied, never KV.
 */
function openLocalSource() {
	const workspace = defineWhispering('OpenAI').create();
	const idb = attachIndexedDb(workspace.ydoc);
	return {
		tables: workspace.tables,
		whenLoaded: idb.whenLoaded,
		clearLocal: idb.clearLocal,
		dispose: () => workspace.ydoc.destroy(),
	};
}

/**
 * Human phrase for what is staged locally, e.g. "12 recordings",
 * "3 transformations", or "12 recordings and 3 transformations". Recordings
 * lead because they dominate; transformation runs ride along in the copy but
 * stay out of the prose (users do not think in "runs"). Falls back to "data"
 * for the rare orphan-run-only case.
 */
function describeLocalContents(counts: Record<string, number>): string {
	const parts: string[] = [];
	const recordings = counts.recordings ?? 0;
	if (recordings > 0) {
		parts.push(`${recordings} recording${recordings === 1 ? '' : 's'}`);
	}
	const transformations = counts.transformations ?? 0;
	if (transformations > 0) {
		parts.push(
			`${transformations} transformation${transformations === 1 ? '' : 's'}`,
		);
	}
	return parts.length > 0 ? parts.join(' and ') : 'data';
}

export const signInMigration = createSignInMigration({
	auth: environment.auth,
	openLocalSource,
	target: whispering,
	describe: describeLocalContents,
	note: (counts) =>
		(counts.recordings ?? 0) > 0
			? 'Audio files stay where they were recorded.'
			: undefined,
	errorNoun: 'recordings',
});
