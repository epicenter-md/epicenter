import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';

import { applyHistorySchema } from './persistence.js';
import { createStore, StoreError, type Store } from './store.js';

/**
 * Open one application's store on Bun.
 *
 * One opener per runtime, each returning a `Result`, rather than one
 * `epicenter.open({ path })` in front of both: the two opens share no I/O
 * profile. This one is a `mkdir` and two SQLite files; the browser's is a WASM
 * compile and an IndexedDB read (`./browser.ts`). Naming the opener for
 * Epicenter while calling its result a store would be a second name for one
 * thing.
 *
 * **No application in this repository calls this today.** Honeycrisp opens the
 * browser store in every build including the Tauri one, by the refusal in
 * `apps/honeycrisp/src/lib/application-platform.ts`: a host serves bundles and
 * owns no application data (ADR-0226). This stays exported because it is a
 * published entry point of an MIT package and because it is the only opener
 * that proves the log survives a real reopen from a real file, which
 * `store.test.ts` uses. An in-repo caller returning is a decision, not a
 * default.
 *
 * @param directory The application's own folder. `store.sqlite3` holds the
 * update log and the projection; `history.sqlite3` holds what collapse
 * superseded.
 */
export async function openBunStore({
	directory,
	keepHistory = true,
}: {
	directory: string;
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

export { dirname };
