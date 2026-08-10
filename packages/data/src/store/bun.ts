import type { LensJson, LensParseError } from '@epicenter/lens';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';

import {
	type Application,
	bindOpened,
	claimNamespace,
	releaseNamespace,
} from './open.js';
import { applyHistorySchema } from './persistence.js';
import { createStore, StoreError, type Store } from './store.js';

/**
 * Open the application this lens names, on Bun.
 *
 * The lens names the store (ADR-0229), so the folder is
 * `<root>/<lens.namespace>` rather than a path a caller picks. The root is
 * where Epicenter lives on this machine (ADR-0201), which is an environment
 * fact rather than a second name for the application.
 *
 * **No application in this repository calls this today.** Honeycrisp opens the
 * browser store in every build including the Tauri one, by the refusal in
 * `apps/honeycrisp/src/lib/application-platform.ts`: a host serves bundles and
 * owns no application data (ADR-0226). This stays exported because it is a
 * published entry point of an MIT package and because it is the only opener
 * that proves the log survives a real reopen from a real file, which
 * `store.test.ts` uses. An in-repo caller returning is a decision, not a
 * default.
 */
export async function open<const TLens extends LensJson>(
	lens: TLens,
	{
		root,
		keepHistory = true,
	}: {
		/** Where Epicenter keeps application folders on this machine (ADR-0201). */
		root: string;
		/** Whether collapse preserves what it supersedes (ADR-0214). */
		keepHistory?: boolean;
	},
): Promise<Result<Application<TLens>, StoreError | LensParseError>> {
	const { error: claimError } = claimNamespace(lens.namespace);
	if (claimError !== null) return Err(claimError);

	const { data: store, error: storeError } = await openBunStore({
		directory: join(root, lens.namespace),
		namespace: lens.namespace,
		keepHistory,
	});
	if (storeError !== null) {
		releaseNamespace(lens.namespace);
		return Err(storeError);
	}

	const bound = bindOpened(lens, store);
	if (bound.error !== null) {
		await store[Symbol.asyncDispose]().catch(() => undefined);
		return Err(bound.error);
	}
	return Ok(bound.data);
}

/**
 * @param directory The application's own folder. `store.sqlite3` holds the
 * update log and the projection; `history.sqlite3` holds what collapse
 * superseded.
 */
async function openBunStore({
	directory,
	namespace,
	keepHistory = true,
}: {
	directory: string;
	namespace: string;
	/**
	 * Whether collapse preserves what it supersedes (ADR-0214).
	 *
	 * On by default: one changed field is 43 bytes on the wire, so at a hundred
	 * edits a day history costs about 4 KB a day, which is cheap enough to keep
	 * without anyone deciding to.
	 */
	keepHistory?: boolean;
}): Promise<Result<Store, StoreError>> {
	const { error: directoryError } = await tryAsync({
		try: () => mkdir(directory, { recursive: true }),
		catch: (cause) => StoreError.StorageFailed({ cause }),
	});
	if (directoryError !== null) return Err(directoryError);

	const live = new Database(join(directory, 'store.sqlite3'));
	const historyDatabase = keepHistory
		? new Database(join(directory, 'history.sqlite3'))
		: undefined;
	const history =
		historyDatabase === undefined
			? undefined
			: createBunSqliteAdapter(historyDatabase);
	if (history !== undefined) applyHistorySchema(history);

	return Ok(
		createStore({
			database: createBunSqliteAdapter(live),
			history,
			dispose: () => {
				live.close();
				historyDatabase?.close();
				releaseNamespace(namespace);
			},
		}),
	);
}

/** Open a store that lives only as long as the process. Test support. */
export function openMemoryStore(): Store {
	const live = new Database(':memory:');
	const history = createBunSqliteAdapter(new Database(':memory:'));
	applyHistorySchema(history);
	return createStore({
		database: createBunSqliteAdapter(live),
		history,
		dispose: () => live.close(),
	});
}
