/**
 * Where Local Books' database lives on disk, and what it is called.
 *
 * The company copy is disposable by construction: everything in it came from
 * QuickBooks and can come from QuickBooks again. So a change to what this build
 * stores is not a migration, it is a different filename. `books.v<version>.db`
 * carries its version in its name, a successor is built beside its predecessor,
 * and opening never drops, truncates, migrates, or unlinks anything. A reader
 * still holding the old file keeps reading it while the new one fills
 * (ADR-0197).
 *
 * This module owns the filename, the directory listing, the two opening modes,
 * and scoped deletion of older versions. It owns nothing else: the version
 * constant, the schema, ingestion, the CDC cursor, "is this file filled yet",
 * locking, file permissions, and when a predecessor may be deleted all stay
 * with the app.
 */

import { constants, Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** The stem every one of this app's database files shares. */
const NAME = 'books';

/**
 * No leading zeros, so one version has exactly one filename and the numeric
 * order and the name can never disagree.
 */
const FILENAME = new RegExp(`^${NAME}\\.v([1-9][0-9]*)\\.db$`);

/** SQLite's sidecars, deleted alongside the file they belong to. */
const SIDECARS = ['-wal', '-shm'] as const;

const BUSY_TIMEOUT_MS = 5000;

/** One version of the database present in a company's directory. */
export type DbFileVersion = {
	version: number;
	/** The company directory joined with this version's filename. */
	path: string;
	/** Whether this is the version this build reads and writes. */
	current: boolean;
};

export type DbFile = {
	readonly version: number;
	/** The current version's path, whether or not it exists yet. */
	readonly path: string;
	/**
	 * Every version of the database in this directory, lowest first, with
	 * `current` marking the one this build names. Reads the directory only: no
	 * SQLite handle is opened, so a file written by a future build is still
	 * listed.
	 *
	 * An absent directory is an empty list, because nothing has been built here
	 * yet. A directory that exists but cannot be read throws, because "I could
	 * not look" and "there is nothing here" are different answers, and reporting
	 * the second for the first turns a broken install into a fresh one.
	 *
	 * This is a directory listing, not readiness. A file existing says nothing
	 * about whether it has been filled; only the app's own cursor can say that.
	 */
	versions(): DbFileVersion[];
	/**
	 * A writable handle on the current version, creating the directory and the
	 * file if either is absent. Creates nothing else and destroys nothing: the
	 * worst a mistaken writable open can do is leave an empty file behind.
	 *
	 * Throws if the path is not a SQLite database, because setting the journal
	 * mode is the first statement that reads the header.
	 */
	open(): Database;
	/**
	 * A read-only handle on the current version, or `null` when it does not
	 * exist. Never creates a file, and never opens a predecessor: a build
	 * compiled for version N reads version N, and reading N-1 would be a
	 * compatibility layer. A caller that wants to inspect an older file takes
	 * its path from `versions()` and opens it itself.
	 *
	 * `null` means absent and nothing more. A handle on a file that is not a
	 * database is still a handle: a reader sets no persistent pragma, so nothing
	 * here reads the header and the failure surfaces on the caller's first
	 * query.
	 */
	openReadonly(): Database | null;
	/**
	 * Delete every LOWER version of the database, plus each one's `-wal` and
	 * `-shm` sidecars, and nothing else. Returns what it deleted.
	 *
	 * Scoped three ways. It never touches the current version; it never touches a
	 * HIGHER one, because that belongs to a newer build that may be running right
	 * now; and it never touches a path the filename pattern does not produce, so
	 * a sibling `lock.db` or `credentials.json` is unreachable. It never
	 * removes the directory, and running it on an empty directory does nothing.
	 *
	 * Timing is the app's, and that is a hazard rather than a preference.
	 * Unlinking a predecessor's `-wal` while another process still holds that
	 * file open discards the transactions the log had not checkpointed, so the
	 * reader keeps answering from a company that silently rolled back; on Windows
	 * the unlink fails outright instead. This module can see neither the open
	 * readers nor the cursor that would say the successor is complete, so it
	 * refuses to guess.
	 *
	 * Call this only where the app can show nothing is reading. Nothing does that
	 * automatically today, which is why it is explicit maintenance and not a step
	 * that follows a version bump.
	 */
	deleteOlderVersions(): DbFileVersion[];
};

/** An `ENOENT` from the filesystem: the path is not there at all. */
function isAbsent(cause: unknown): boolean {
	return (
		typeof cause === 'object' &&
		cause !== null &&
		'code' in cause &&
		cause.code === 'ENOENT'
	);
}

/**
 * Apply a connection's pragmas, closing the handle if one of them fails.
 *
 * `new Database(...)` opens lazily, so a pragma is the first statement that
 * actually reaches the file and therefore the first that can fail on a missing
 * permission or a path that is not a database. Without the close, every such
 * failure would leak the descriptor it had already opened, which a long-running
 * daemon retrying a broken file would accumulate.
 */
function applyPragmas(db: Database, pragmas: readonly string[]): Database {
	try {
		for (const pragma of pragmas) db.run(pragma);
	} catch (cause) {
		db.close();
		throw cause;
	}
	return db;
}

/**
 * Open flags for a writable handle: create if absent, plus URI filename
 * parsing.
 *
 * `SQLITE_OPEN_URI` is here because SQL has no read-only `ATTACH`. A caller
 * that wants to read a sibling database without becoming its second writer can
 * only say so as `file:<path>?mode=ro`, and SQLite parses that form only when
 * the connection asked for it or the library was built with `SQLITE_USE_URI`.
 * bun's macOS build has that flag compiled in and its Linux build does not, so
 * a connection that leaves this to the platform works on one and, on the other,
 * looks for a file literally named `file:...?mode=ro` and reports that it
 * cannot open the database. Asking here makes the capability the caller's to
 * rely on rather than the host's to grant.
 */
const WRITABLE_FLAGS =
	constants.SQLITE_OPEN_READWRITE |
	constants.SQLITE_OPEN_CREATE |
	constants.SQLITE_OPEN_URI;

/** The same capability for a reader, which attaches siblings just as a writer does. */
const READONLY_FLAGS =
	constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI;

/**
 * The database in one company's directory, at one version.
 *
 * `version` is a property of the code rather than of a release, and `db.ts`
 * owns the constant that supplies it. Tests pass a different number to stand in
 * for an older or newer build.
 */
export function dbFileAt({
	directory,
	version,
}: {
	directory: string;
	version: number;
}): DbFile {
	const path = join(directory, `${NAME}.v${version}.db`);

	function versions(): DbFileVersion[] {
		let filenames: string[];
		try {
			filenames = readdirSync(directory);
		} catch (cause) {
			// Only "the directory is not there" is an empty list. A permission the
			// process lacks, or a regular file sitting where the directory belongs,
			// is a broken site, and swallowing it here would let `status` report a
			// directory it could not read as one with nothing built in it.
			if (isAbsent(cause)) return [];
			throw cause;
		}
		return filenames
			.map((filename) => {
				const found = FILENAME.exec(filename)?.[1];
				const parsed = found === undefined ? Number.NaN : Number(found);
				// A matching name whose digits overflow a safe integer is dropped
				// rather than compared: it cannot be ordered honestly, and being
				// invisible to the listing also puts it out of deletion's reach.
				if (!Number.isSafeInteger(parsed)) return null;
				return {
					version: parsed,
					path: join(directory, filename),
					current: parsed === version,
				};
			})
			.filter((entry) => entry !== null)
			.sort((a, b) => a.version - b.version);
	}

	return {
		version,
		path,

		versions,

		open(): Database {
			mkdirSync(directory, { recursive: true });
			// WAL so readers never block the writer; a busy_timeout so a second
			// writer waits for the lock instead of failing instantly with
			// SQLITE_BUSY; synchronous NORMAL because this file is re-pullable by
			// construction, so a lost last commit on power loss costs a re-pull and
			// nothing more.
			return applyPragmas(new Database(path, WRITABLE_FLAGS), [
				`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`,
				'PRAGMA journal_mode = WAL;',
				'PRAGMA synchronous = NORMAL;',
				'PRAGMA foreign_keys = ON;',
			]);
		},

		openReadonly(): Database | null {
			if (!existsSync(path)) return null;
			// No journal-mode change and no other persistent pragma: a reader touches
			// nothing. The timeout is per-connection, so it still applies.
			return applyPragmas(new Database(path, READONLY_FLAGS), [
				`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`,
			]);
		},

		deleteOlderVersions(): DbFileVersion[] {
			const older = versions().filter((entry) => entry.version < version);
			for (const entry of older) {
				// Sidecars first, the database last: an interrupted delete then leaves
				// a readable database rather than an orphaned write-ahead log that a
				// later file of the same name would find beside it.
				for (const suffix of SIDECARS) {
					rmSync(`${entry.path}${suffix}`, { force: true });
				}
				rmSync(entry.path, { force: true });
			}
			return older;
		},
	};
}
