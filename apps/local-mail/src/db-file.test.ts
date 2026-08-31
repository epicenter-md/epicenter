/**
 * What the database file on disk promises: the version in the filename is what
 * this build stores, opening never destroys, a build reads its own version and
 * never falls back, and deletion is scoped to lower versions of this exact
 * name.
 */

import { describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbFileAt } from './db-file.ts';

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'mail-db-file-test-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const at = (directory: string, version = 1) => dbFileAt({ directory, version });

test('names the file mail.v<version>.db', () => {
	expect(at('/tmp/site', 5).path).toBe('/tmp/site/mail.v5.db');
	expect(at('/tmp/site', 12).path).toBe('/tmp/site/mail.v12.db');
});

describe('opening', () => {
	test('creates the current version, and only that one', () => {
		const tmp = tempDir();
		const file = at(join(tmp.dir, 'you@example.com'), 5);

		expect(file.versions()).toEqual([]);
		file.open().close();

		expect(existsSync(file.path)).toBe(true);
		expect(file.versions()).toEqual([
			{ version: 5, path: file.path, current: true },
		]);
		tmp.cleanup();
	});

	test('a file that is not a database fails the writable open outright', () => {
		const tmp = tempDir();
		const file = at(tmp.dir, 5);
		writeFileSync(file.path, 'not a database at all');

		// Setting the journal mode is the first statement to read the header, so a
		// writable open cannot hand back a handle that only looks usable. It also
		// does not repair or replace the file: `open()` destroys nothing.
		expect(() => file.open()).toThrow();
		expect(readFileSync(file.path, 'utf8')).toBe('not a database at all');

		// A reader sets no persistent pragma, so nothing on this path reads the
		// header and the failure lands on the caller's first query instead. `null`
		// from `openReadonly()` means absent, never unusable.
		const reader = file.openReadonly();
		expect(reader).not.toBeNull();
		expect(() => reader?.query('SELECT 1 FROM sqlite_master').all()).toThrow();
		reader?.close();
		tmp.cleanup();
	});

	test('read-only reports an absent file instead of conjuring one', () => {
		const tmp = tempDir();
		const file = at(join(tmp.dir, 'you@example.com'), 5);
		expect(file.openReadonly()).toBeNull();
		expect(existsSync(file.path)).toBe(false);
		tmp.cleanup();
	});

	test('reopening keeps every row: nothing is dropped or migrated', () => {
		const tmp = tempDir();
		const file = at(tmp.dir, 5);
		const first = file.open();
		first.run('CREATE TABLE t (id TEXT PRIMARY KEY);');
		first.run(`INSERT INTO t (id) VALUES ('a');`);
		first.close();

		const second = file.open();
		expect(second.query('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 });
		second.close();

		const reader = file.openReadonly();
		expect(reader?.query('SELECT count(*) AS n FROM t').get()).toEqual({
			n: 1,
		});
		reader?.close();
		tmp.cleanup();
	});
});

describe('a bumped version', () => {
	test('names a new file and leaves the predecessor untouched', () => {
		const tmp = tempDir();
		const before = at(tmp.dir, 5);
		const db = before.open();
		db.run('CREATE TABLE t (id TEXT PRIMARY KEY);');
		db.run(`INSERT INTO t (id) VALUES ('a');`);
		db.close();

		const after = at(tmp.dir, 6);
		expect(after.path).not.toBe(before.path);

		// No fallback: the successor's reader sees no materialization rather than
		// reading v5, which this build no longer promises the shape of. Reading it
		// would be a compatibility layer.
		expect(after.openReadonly()).toBeNull();

		after.open().close();
		expect(after.versions()).toEqual([
			{ version: 5, path: before.path, current: false },
			{ version: 6, path: after.path, current: true },
		]);

		// The predecessor's rows are still there, opened deliberately by its path,
		// and nothing was transferred into the successor: a bump is a re-pull from
		// Gmail, never a migration.
		expect(existsSync(before.path)).toBe(true);
		const old = before.openReadonly();
		expect(old?.query('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 });
		old?.close();

		// Writable, because a brand-new file has no schema yet and a read-only
		// handle on a WAL database with no `-shm` beside it cannot be opened. The
		// app runs its DDL on the handle `open()` returns, so this is the same
		// order it uses.
		const fresh = after.open();
		expect(
			fresh
				.query(`SELECT count(*) AS n FROM sqlite_master WHERE name = 't'`)
				.get(),
		).toEqual({ n: 0 });
		fresh.close();
		tmp.cleanup();
	});
});

describe('versions()', () => {
	test("lists only this app's database files, never a sibling it owns", () => {
		const tmp = tempDir();
		const file = at(tmp.dir, 5);
		file.open().close();
		writeFileSync(join(tmp.dir, 'lock.db'), '');
		writeFileSync(join(tmp.dir, 'intent.db'), '');
		writeFileSync(join(tmp.dir, 'credentials.json'), '{}');
		writeFileSync(join(tmp.dir, 'mail.db'), '');
		writeFileSync(join(tmp.dir, 'mail.v0.db'), '');
		writeFileSync(join(tmp.dir, 'mail.v05.db'), '');
		writeFileSync(join(tmp.dir, 'mail.vx.db'), '');
		writeFileSync(join(tmp.dir, 'books.v5.db'), '');

		expect(file.versions().map((entry) => entry.path)).toEqual([
			join(tmp.dir, 'mail.v5.db'),
		]);
		tmp.cleanup();
	});

	test('sorts numerically, not lexicographically', () => {
		const tmp = tempDir();
		for (const version of [2, 10, 1, 21, 3])
			at(tmp.dir, version).open().close();
		expect(
			at(tmp.dir, 3)
				.versions()
				.map((entry) => entry.version),
		).toEqual([1, 2, 3, 10, 21]);
		tmp.cleanup();
	});

	test('is an empty list, not an error, when the directory does not exist', () => {
		const tmp = tempDir();
		expect(at(join(tmp.dir, 'nope'), 5).versions()).toEqual([]);
		tmp.cleanup();
	});

	test('refuses to call a directory it could not read an empty one', () => {
		const tmp = tempDir();
		// A regular file where the directory belongs. An absent directory is an
		// empty list because nothing has been built yet; this is a broken site, and
		// answering `[]` would let `status` report it as a fresh install.
		const occupied = join(tmp.dir, 'occupied');
		writeFileSync(occupied, '');
		expect(() => at(occupied, 5).versions()).toThrow();
		tmp.cleanup();
	});

	test('opens no SQLite handle, so an unreadable file is still listed', () => {
		const tmp = tempDir();
		writeFileSync(join(tmp.dir, 'mail.v4.db'), 'not a database at all');
		expect(at(tmp.dir, 5).versions()).toEqual([
			{ version: 4, path: join(tmp.dir, 'mail.v4.db'), current: false },
		]);
		tmp.cleanup();
	});
});

describe('deleteOlderVersions', () => {
	test('deletes every lower version and its sidecars, and nothing else', () => {
		const tmp = tempDir();
		at(tmp.dir, 3).open().close();
		const before = at(tmp.dir, 4);
		before.open().close();
		writeFileSync(`${before.path}-wal`, '');
		writeFileSync(`${before.path}-shm`, '');
		// The siblings the app keeps beside its database. Deletion is scoped to the
		// filename pattern precisely so a sync lock, the durable intent store, and
		// an OAuth refresh token are unreachable from it.
		writeFileSync(join(tmp.dir, 'lock.db'), '');
		writeFileSync(join(tmp.dir, 'intent.db'), '');
		writeFileSync(join(tmp.dir, 'credentials.json'), '{}');

		const current = at(tmp.dir, 5);
		current.open().close();
		expect(current.deleteOlderVersions().map((entry) => entry.version)).toEqual(
			[3, 4],
		);

		expect(existsSync(before.path)).toBe(false);
		expect(existsSync(`${before.path}-wal`)).toBe(false);
		expect(existsSync(`${before.path}-shm`)).toBe(false);
		expect(readdirSync(tmp.dir).sort()).toEqual(
			['credentials.json', 'intent.db', 'lock.db', 'mail.v5.db'].sort(),
		);
		tmp.cleanup();
	});

	test('never touches the current version', () => {
		const tmp = tempDir();
		const file = at(tmp.dir, 5);
		file.open().close();
		expect(file.deleteOlderVersions()).toEqual([]);
		expect(existsSync(file.path)).toBe(true);
		tmp.cleanup();
	});

	test('never touches a higher version, which a newer build may be running on', () => {
		const tmp = tempDir();
		const future = at(tmp.dir, 6);
		future.open().close();
		const current = at(tmp.dir, 5);
		current.open().close();

		expect(current.deleteOlderVersions()).toEqual([]);
		expect(existsSync(future.path)).toBe(true);
		expect(existsSync(current.path)).toBe(true);
		tmp.cleanup();
	});

	test('running on an empty directory does nothing', () => {
		const tmp = tempDir();
		expect(at(join(tmp.dir, 'nope'), 5).deleteOlderVersions()).toEqual([]);
		expect(existsSync(join(tmp.dir, 'nope'))).toBe(false);
		tmp.cleanup();
	});
});
