import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import { createEpicenter } from './epicenter.js';
import { openReplica } from './replica/index.js';

/**
 * Where a Bun-owned Epicenter lives: either the exact database path or the
 * directory that holds it under the canonical file name.
 *
 * Both spellings name the same durable thing, so both behave identically. A
 * caller that already holds a path (inspection wants one, tests name one) never
 * gets a weaker opener than a caller that hands over a directory.
 */
export type OpenBunEpicenterOptions =
	| { path: string; directory?: never }
	| { path?: never; directory: string };

/** The one file name a Bun-owned Epicenter uses inside its directory. */
export const EPICENTER_FILE_NAME = 'epicenter.sqlite3';

/** The SQLite path that names a transient database instead of a file. */
const IN_MEMORY_PATH = ':memory:';

/**
 * Resolve the database path without opening it.
 *
 * Exported because inspection opens a second, read-only connection to the same
 * file, and both openers must agree on the path by construction rather than by
 * repeating the join.
 */
export function epicenterPath(options: OpenBunEpicenterOptions): string {
	return options.path ?? join(options.directory, EPICENTER_FILE_NAME);
}

/**
 * Open one Bun SQLite-backed Epicenter replica, creating its home if the
 * install is new enough that nothing has written there yet.
 *
 * SQLite's `create: true` promises the file and stops there, which is a
 * half-kept promise: on a fresh profile the folder holding that file does not
 * exist either, and the open fails with a bare `unable to open database file`.
 * The component that decides where the database lives is the one that makes the
 * place it lives, so every caller gets the same first boot instead of each
 * remembering its own mkdir.
 */
export async function openBunEpicenter(
	options: OpenBunEpicenterOptions,
): Promise<ReturnType<typeof createEpicenter>> {
	const path = epicenterPath(options);
	if (path !== IN_MEMORY_PATH) {
		await mkdir(dirname(path), { recursive: true });
	}
	const rawDatabase = new Database(path, { create: true });
	try {
		const database = createBunSqliteAdapter(rawDatabase);
		const opened = openReplica({ database });
		if (opened.error !== null) throw opened.error;
		return createEpicenter({
			replica: opened.data,
			database,
			dispose: () => rawDatabase.close(),
		});
	} catch (cause) {
		rawDatabase.close();
		throw cause;
	}
}
