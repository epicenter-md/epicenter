/**
 * A mirror is a disposable local SQLite copy of data an external authority
 * owns. The version of the corpus contract that built it is in its filename:
 * `<name>.v<version>.db`. A contract change is not an event the opener handles,
 * it is a different filename, so opening never drops, truncates, migrates, or
 * unlinks anything, and a reader still holding the old artifact keeps reading it
 * while the new one is built beside it.
 *
 *     const mirror = mirrorAt({ name: 'mail', version: 5, directory: accountDir });
 *     mirror.open();                  // writable, created if absent
 *     mirror.openReadonly();          // read-only, `null` when absent
 *     mirror.artifacts();             // what exists here, and which one is current
 *     mirror.reclaimPredecessors();   // delete every older artifact + sidecars
 *
 * `name`, `version`, and `directory` are the only inputs: no realm, domain,
 * authority identifier, filename override, or path template. Per-tenant naming
 * is the caller's, expressed in the directory it passes.
 *
 * This module owns the filename grammar, path construction, artifact inventory,
 * the two opening modes, and grammar-scoped deletion. It owns nothing else: DDL,
 * ingestion, cursors, "is this artifact usable yet", locking, file permissions,
 * and reclamation timing all stay with the application.
 *
 * Bun and the filesystem are hard dependencies here, which is why this is its
 * own entry point (`@epicenter/sqlite/bun-mirror`) rather than part of the
 * portable root.
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** One artifact present in a mirror's directory. */
export type MirrorArtifact = {
	version: number;
	/** The mirror's directory joined with this artifact's filename. */
	path: string;
	/** Whether this is the artifact the live version names. */
	current: boolean;
};

export type Mirror = {
	readonly version: number;
	/** The current artifact's path, whether or not it exists yet. */
	readonly path: string;
	/**
	 * Every artifact of this mirror name in this directory, lowest version first,
	 * with `current` marking the one this version names. Reads the directory only:
	 * no SQLite handle is opened, so an artifact written by a future build is still
	 * listed.
	 *
	 * An absent directory is an empty inventory, because nothing has been built
	 * here yet. A directory that exists but cannot be read throws, because "I could
	 * not look" and "there is nothing here" are different answers and a caller that
	 * reports the second for the first is reporting a broken install as a fresh
	 * one.
	 *
	 * This is inventory, not readiness. A file existing says nothing about whether
	 * it has been filled; only the application's own cursor can say that.
	 */
	artifacts(): MirrorArtifact[];
	/**
	 * A writable handle on the current artifact, creating the directory and the
	 * file if either is absent, with the concurrency contract applied. Creates
	 * nothing else and destroys nothing: the worst a mistaken writable open can do
	 * is leave an empty file behind.
	 *
	 * Throws if the path is not a SQLite database, because setting the journal mode
	 * is the first statement that reads the header.
	 */
	open(): Database;
	/**
	 * A read-only handle on the current artifact, or `null` when it does not exist.
	 * Never creates a file, and never opens a predecessor: a build compiled for
	 * version N reads version N, and reading N-1 would be a compatibility layer.
	 * A caller that wants to inspect an older artifact takes its path from
	 * `artifacts()` and opens it itself.
	 *
	 * `null` means absent and nothing more. A handle on a file that is not a
	 * database is still a handle: a reader sets no persistent pragma, so nothing
	 * here reads the header and the failure surfaces on the caller's first query.
	 */
	openReadonly(): Database | null;
	/**
	 * Delete every artifact of this name at a LOWER version, plus each one's `-wal`
	 * and `-shm` sidecars, and nothing else. Returns what it deleted.
	 *
	 * Scoped three ways. It never touches the current artifact; it never touches a
	 * HIGHER version, because that one belongs to a newer build that may be running
	 * right now; and it never touches a path the filename grammar does not produce,
	 * so a sibling `lock.db` or `credentials.json` is unreachable. It never removes
	 * the directory, and reclaiming an empty directory is a no-op.
	 *
	 * Timing is the application's, and that is a hazard rather than a preference.
	 * Unlinking a predecessor's `-wal` while another process still holds that
	 * artifact open discards the transactions the log had not checkpointed, so the
	 * reader keeps answering from a corpus that silently rolled back; on Windows
	 * the unlink fails outright instead. The primitive can see neither the open
	 * readers nor the cursor that would say the successor is complete, so it
	 * refuses to guess.
	 *
	 * Call this only where the application can show nothing is reading. No app does
	 * that automatically today, which is why this is explicit maintenance and not a
	 * step that follows a version bump.
	 */
	reclaimPredecessors(): MirrorArtifact[];
};

/**
 * Lowercase hyphenated, so the name is safe in a filename on every platform and
 * cannot collide with the `.` separators or the `v<version>` segment.
 */
const MIRROR_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** SQLite's sidecars, deleted alongside the artifact they belong to. */
const SIDECARS = ['-wal', '-shm'] as const;

const BUSY_TIMEOUT_MS = 5000;

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
 * daemon retrying a broken mirror would accumulate.
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
 * Open a mirror: a name for its artifacts, the corpus-contract version that
 * builds them, and the directory they live in.
 *
 * `version` is a property of the code, not of a release. Bump it when the
 * persisted SQL shape changes, when what a persisted derivation means changes,
 * or when the ingestion scope changes, because each of those makes an existing
 * artifact a copy of something the current build no longer promises. Do not bump
 * it for indexes, read-time projections, comments, or shipping a new version of
 * the app: none of those change what is stored.
 */
export function mirrorAt({
	name,
	version,
	directory,
}: {
	name: string;
	version: number;
	directory: string;
}): Mirror {
	if (!MIRROR_NAME.test(name)) {
		throw new Error(
			`Mirror name "${name}" must be lowercase alphanumeric words joined by single hyphens.`,
		);
	}
	if (!Number.isSafeInteger(version) || version < 1) {
		throw new Error(
			`Mirror version ${version} must be a positive integer; versions start at 1 and only ever increase.`,
		);
	}

	// No leading zeros, so one version has exactly one filename and the numeric
	// order and the name are never in disagreement.
	const artifactPattern = new RegExp(`^${name}\\.v([1-9][0-9]*)\\.db$`);
	const path = join(directory, `${name}.v${version}.db`);

	function artifacts(): MirrorArtifact[] {
		let filenames: string[];
		try {
			filenames = readdirSync(directory);
		} catch (cause) {
			// Only "the directory is not there" is an empty inventory. A permission
			// the process lacks, or a regular file sitting where the directory
			// belongs, is a broken site, and swallowing it here would let `status`
			// report a directory it could not read as one with nothing built in it.
			if (isAbsent(cause)) return [];
			throw cause;
		}
		return filenames
			.map((filename) => {
				const found = artifactPattern.exec(filename)?.[1];
				const parsed = found === undefined ? Number.NaN : Number(found);
				// A matching name whose digits overflow a safe integer is dropped
				// rather than compared: it cannot be ordered honestly, and being
				// invisible to inventory also puts it out of reclamation's reach.
				if (!Number.isSafeInteger(parsed)) return null;
				return {
					version: parsed,
					path: join(directory, filename),
					current: parsed === version,
				};
			})
			.filter((artifact) => artifact !== null)
			.sort((a, b) => a.version - b.version);
	}

	return {
		version,
		path,

		artifacts,

		open(): Database {
			mkdirSync(directory, { recursive: true });
			// The concurrency contract every mirror shares. WAL so readers never
			// block the writer; a busy_timeout so a second writer waits for the lock
			// instead of failing instantly with SQLITE_BUSY; synchronous NORMAL
			// because a mirror is re-pullable by construction, so a lost last commit
			// on power loss costs a re-pull and nothing more.
			return applyPragmas(new Database(path, { create: true }), [
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
			return applyPragmas(new Database(path, { readonly: true }), [
				`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`,
			]);
		},

		reclaimPredecessors(): MirrorArtifact[] {
			const predecessors = artifacts().filter(
				(artifact) => artifact.version < version,
			);
			for (const artifact of predecessors) {
				// Sidecars first, the artifact last: an interrupted reclaim then leaves
				// a readable database rather than an orphaned write-ahead log that a
				// later artifact of the same name would find beside it.
				for (const suffix of SIDECARS) {
					rmSync(`${artifact.path}${suffix}`, { force: true });
				}
				rmSync(artifact.path, { force: true });
			}
			return predecessors;
		},
	};
}
