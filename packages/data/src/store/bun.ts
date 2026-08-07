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
 * `epicenter.open({ path })` in front of all of them: the three opens share no
 * I/O profile at all. This one is a `mkdir`; the browser's is a Web Lock plus a
 * WASM compile plus an OPFS pool; the desktop's is two round trips that never
 * open a file. Naming the opener for Epicenter while calling its result a store
 * would be a second name for one thing.
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
