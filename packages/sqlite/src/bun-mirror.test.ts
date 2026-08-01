/**
 * The mirror primitive's contract: the version in the filename is the corpus
 * contract that built the artifact, opening never destroys, a build reads its
 * own version and never falls back, and reclamation is scoped to lower versions
 * of this exact name.
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
import { mirrorAt } from './bun-mirror.ts';

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'bun-mirror-test-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const widgets = (directory: string, version = 1) =>
	mirrorAt({ name: 'widgets', version, directory });

describe('the name grammar', () => {
	test('accepts lowercase words joined by single hyphens', () => {
		for (const name of ['mail', 'local-mail', 'v2', 'a-b-c']) {
			expect(() =>
				mirrorAt({ name, version: 1, directory: '/tmp/site' }),
			).not.toThrow();
		}
	});

	test('refuses anything that could confuse the filename', () => {
		for (const name of [
			'Mail',
			'mail_db',
			'mail.db',
			'-mail',
			'mail-',
			'mail--db',
			'',
			'../mail',
		]) {
			expect(() =>
				mirrorAt({ name, version: 1, directory: '/tmp/site' }),
			).toThrow(/lowercase alphanumeric/);
		}
	});
});

describe('the version grammar', () => {
	test('is a positive integer', () => {
		for (const version of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() =>
				mirrorAt({ name: 'widgets', version, directory: '/tmp/site' }),
			).toThrow(/positive integer/);
		}
		expect(() =>
			mirrorAt({ name: 'widgets', version: 1, directory: '/tmp/site' }),
		).not.toThrow();
	});

	test('names the artifact <name>.v<version>.db', () => {
		expect(widgets('/tmp/site', 5).path).toBe('/tmp/site/widgets.v5.db');
		expect(widgets('/tmp/site', 12).path).toBe('/tmp/site/widgets.v12.db');
	});
});

describe('opening', () => {
	test('creates the current artifact, and only that artifact', () => {
		const tmp = tempDir();
		const dir = join(tmp.dir, 'you@example.com');
		const mirror = widgets(dir, 5);

		expect(mirror.artifacts()).toEqual([]);
		mirror.open().close();

		expect(existsSync(mirror.path)).toBe(true);
		expect(mirror.artifacts()).toEqual([
			{
				version: 5,
				path: mirror.path,
				current: true,
			},
		]);
		tmp.cleanup();
	});

	test('a file that is not a database fails the writable open outright', () => {
		const tmp = tempDir();
		const mirror = widgets(tmp.dir, 5);
		writeFileSync(mirror.path, 'not a database at all');

		// Setting the journal mode is the first statement to read the header, so a
		// writable open cannot hand back a handle that only looks usable. It also
		// does not repair or replace the file: `open()` destroys nothing.
		expect(() => mirror.open()).toThrow();
		expect(readFileSync(mirror.path, 'utf8')).toBe('not a database at all');

		// A reader sets no persistent pragma, so nothing on this path reads the
		// header and the failure lands on the caller's first query instead. `null`
		// from `openReadonly()` means absent, never unusable.
		const reader = mirror.openReadonly();
		expect(reader).not.toBeNull();
		expect(() => reader?.query('SELECT 1 FROM sqlite_master').all()).toThrow();
		reader?.close();
		tmp.cleanup();
	});

	test('read-only reports an absent artifact instead of conjuring one', () => {
		const tmp = tempDir();
		const mirror = widgets(join(tmp.dir, 'you@example.com'), 5);
		expect(mirror.openReadonly()).toBeNull();
		expect(existsSync(mirror.path)).toBe(false);
		tmp.cleanup();
	});

	test('reopening keeps every row: nothing is dropped or migrated', () => {
		const tmp = tempDir();
		const mirror = widgets(tmp.dir, 5);
		const first = mirror.open();
		first.run('CREATE TABLE t (id TEXT PRIMARY KEY);');
		first.run(`INSERT INTO t (id) VALUES ('a');`);
		first.close();

		const second = mirror.open();
		expect(second.query('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 });
		second.close();

		const reader = mirror.openReadonly();
		expect(reader?.query('SELECT count(*) AS n FROM t').get()).toEqual({
			n: 1,
		});
		reader?.close();
		tmp.cleanup();
	});
});

describe('a bumped version', () => {
	test('names a new artifact and leaves the predecessor untouched', () => {
		const tmp = tempDir();
		const before = widgets(tmp.dir, 5);
		const db = before.open();
		db.run('CREATE TABLE t (id TEXT PRIMARY KEY);');
		db.run(`INSERT INTO t (id) VALUES ('a');`);
		db.close();

		const after = widgets(tmp.dir, 6);
		expect(after.path).not.toBe(before.path);

		// No fallback: the successor's reader sees no materialization rather than
		// reading v5, which this build no longer promises the shape of. Reading it
		// would be a compatibility layer.
		expect(after.openReadonly()).toBeNull();

		after.open().close();
		expect(after.artifacts()).toEqual([
			{ version: 5, path: before.path, current: false },
			{ version: 6, path: after.path, current: true },
		]);

		// The predecessor's rows are still there, opened deliberately by its path,
		// and nothing was transferred into the successor: a bump is a rebuild from
		// the authority, never a migration.
		expect(existsSync(before.path)).toBe(true);
		const old = before.openReadonly();
		expect(old?.query('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 });
		old?.close();

		// Writable, because a brand-new artifact has no schema yet and a read-only
		// handle on a WAL database with no `-shm` beside it cannot be opened. Both
		// apps run their DDL on the handle `open()` returns, so this is the same
		// order they use.
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

describe('artifacts()', () => {
	test("lists only this mirror's files, never a sibling the app owns", () => {
		const tmp = tempDir();
		const mirror = widgets(tmp.dir, 5);
		mirror.open().close();
		writeFileSync(join(tmp.dir, 'lock.db'), '');
		writeFileSync(join(tmp.dir, 'credentials.json'), '{}');
		writeFileSync(join(tmp.dir, 'provider.json'), '{}');
		writeFileSync(join(tmp.dir, 'widgets.db'), '');
		writeFileSync(join(tmp.dir, 'widgets.v0.db'), '');
		writeFileSync(join(tmp.dir, 'widgets.v05.db'), '');
		writeFileSync(join(tmp.dir, 'widgets.vx.db'), '');
		writeFileSync(join(tmp.dir, 'gadgets.v5.db'), '');

		expect(mirror.artifacts().map((a) => a.path)).toEqual([
			join(tmp.dir, 'widgets.v5.db'),
		]);
		tmp.cleanup();
	});

	test('sorts numerically, not lexicographically', () => {
		const tmp = tempDir();
		for (const version of [2, 10, 1, 21, 3]) {
			widgets(tmp.dir, version).open().close();
		}
		expect(
			widgets(tmp.dir, 3)
				.artifacts()
				.map((a) => a.version),
		).toEqual([1, 2, 3, 10, 21]);
		tmp.cleanup();
	});

	test('is an empty inventory, not an error, when the directory does not exist', () => {
		const tmp = tempDir();
		expect(widgets(join(tmp.dir, 'nope'), 5).artifacts()).toEqual([]);
		tmp.cleanup();
	});

	test('refuses to call a directory it could not read an empty one', () => {
		const tmp = tempDir();
		// A regular file where the directory belongs. An absent directory is an
		// empty inventory because nothing has been built yet; this is a broken
		// site, and answering `[]` would let `status` report it as a fresh install.
		const occupied = join(tmp.dir, 'occupied');
		writeFileSync(occupied, '');
		expect(() => widgets(occupied, 5).artifacts()).toThrow();
		tmp.cleanup();
	});

	test('opens no SQLite handle, so an unreadable artifact is still inventory', () => {
		const tmp = tempDir();
		writeFileSync(join(tmp.dir, 'widgets.v4.db'), 'not a database at all');
		expect(widgets(tmp.dir, 5).artifacts()).toEqual([
			{ version: 4, path: join(tmp.dir, 'widgets.v4.db'), current: false },
		]);
		tmp.cleanup();
	});
});

describe('reclaimPredecessors', () => {
	test('deletes every lower version and its sidecars, and nothing else', () => {
		const tmp = tempDir();
		widgets(tmp.dir, 3).open().close();
		const before = widgets(tmp.dir, 4);
		before.open().close();
		writeFileSync(`${before.path}-wal`, '');
		writeFileSync(`${before.path}-shm`, '');
		// The siblings an app keeps beside its mirror. Reclamation is scoped to the
		// filename grammar precisely so a sync lock and an OAuth refresh token are
		// unreachable from it.
		writeFileSync(join(tmp.dir, 'lock.db'), '');
		writeFileSync(join(tmp.dir, 'credentials.json'), '{}');
		writeFileSync(join(tmp.dir, 'provider.json'), '{}');

		const current = widgets(tmp.dir, 5);
		current.open().close();
		expect(current.reclaimPredecessors().map((a) => a.version)).toEqual([3, 4]);

		expect(existsSync(before.path)).toBe(false);
		expect(existsSync(`${before.path}-wal`)).toBe(false);
		expect(existsSync(`${before.path}-shm`)).toBe(false);
		expect(readdirSync(tmp.dir).sort()).toEqual(
			['credentials.json', 'lock.db', 'provider.json', 'widgets.v5.db'].sort(),
		);
		tmp.cleanup();
	});

	test('never touches the current artifact', () => {
		const tmp = tempDir();
		const mirror = widgets(tmp.dir, 5);
		mirror.open().close();
		expect(mirror.reclaimPredecessors()).toEqual([]);
		expect(existsSync(mirror.path)).toBe(true);
		tmp.cleanup();
	});

	test('never touches a higher version, which a newer build may be running on', () => {
		const tmp = tempDir();
		const future = widgets(tmp.dir, 6);
		future.open().close();
		const current = widgets(tmp.dir, 5);
		current.open().close();

		expect(current.reclaimPredecessors()).toEqual([]);
		expect(existsSync(future.path)).toBe(true);
		expect(existsSync(current.path)).toBe(true);
		tmp.cleanup();
	});

	test('reclaiming an empty directory is a no-op', () => {
		const tmp = tempDir();
		expect(widgets(join(tmp.dir, 'nope'), 5).reclaimPredecessors()).toEqual([]);
		expect(existsSync(join(tmp.dir, 'nope'))).toBe(false);
		tmp.cleanup();
	});
});
