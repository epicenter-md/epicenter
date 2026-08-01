/**
 * The mirror primitive's contract (ADR-0194): the fingerprint is a statement
 * about the declared shape and nothing else, the filename grammar is what makes
 * deletion safe, opening never destroys, and reclaim is scoped to exactly one
 * non-current artifact.
 *
 * The golden fingerprint below is pinned deliberately. It is the whole guarantee:
 * if the canonical serialization ever changes, every mirror in the field renames
 * its artifact and re-pulls, so that must be a decision someone makes on purpose
 * (by bumping the format tag) rather than a refactor's side effect.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DeclarationValue, defineMirror } from '../src/mirror.ts';
import { tempDir } from './helpers.ts';

/** A declaration exercising every supported value kind, in unsorted key order. */
const SAMPLE: DeclarationValue = {
	b: [1, 'two', true, null],
	a: { z: 1, y: [] },
};

const SAMPLE_FINGERPRINT =
	'9a1dd5030b19d46de0ed9027ee52d7a73bbadcb4abc67cd561fbb70e36d2a1e6';

const widgets = () => defineMirror({ name: 'widgets', declaration: SAMPLE });

/** A mirror whose declaration differs from `SAMPLE` by one leaf. */
const widgetsV2 = () =>
	defineMirror({
		name: 'widgets',
		declaration: { b: [1, 'two', true, null], a: { z: 2, y: [] } },
	});

describe('the fingerprint', () => {
	test('is the pinned hash of the canonical serialization', () => {
		expect(widgets().fingerprint).toBe(SAMPLE_FINGERPRINT);
	});

	test('ignores object key order, so authoring order is not rebuild behavior', () => {
		const reordered = defineMirror({
			name: 'widgets',
			declaration: { a: { y: [], z: 1 }, b: [1, 'two', true, null] },
		});
		expect(reordered.fingerprint).toBe(SAMPLE_FINGERPRINT);
	});

	test('preserves array order, because a column list is ordered', () => {
		const swapped = defineMirror({
			name: 'widgets',
			declaration: { b: ['two', 1, true, null], a: { z: 1, y: [] } },
		});
		expect(swapped.fingerprint).not.toBe(SAMPLE_FINGERPRINT);
	});

	test('does not include the name: two names, one shape, one fingerprint', () => {
		const renamed = defineMirror({ name: 'gadgets', declaration: SAMPLE });
		expect(renamed.fingerprint).toBe(SAMPLE_FINGERPRINT);
	});

	test('rejects values it cannot canonically serialize', () => {
		const reject = (declaration: unknown) =>
			expect(() =>
				defineMirror({
					name: 'widgets',
					declaration: declaration as DeclarationValue,
				}),
			).toThrow();

		reject({ at: new Date(0) }); // a class instance, not a plain object
		reject({ seen: new Set([1]) });
		reject({ build: () => 1 });
		reject({ absent: undefined });
		reject({ count: Number.NaN });
		reject({ count: Number.POSITIVE_INFINITY });
		reject({ big: 1n });
		reject([Symbol('x')]);
	});

	test('rejects a cyclic declaration instead of hanging', () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() =>
			defineMirror({
				name: 'widgets',
				declaration: cyclic as DeclarationValue,
			}),
		).toThrow(/cyclic/);
	});
});

describe('the name grammar', () => {
	test('accepts lowercase words joined by single hyphens', () => {
		for (const name of ['books', 'local-books', 'v2', 'a-b-c']) {
			expect(() => defineMirror({ name, declaration: SAMPLE })).not.toThrow();
		}
	});

	test('refuses anything that could confuse the filename', () => {
		for (const name of [
			'Books',
			'books_db',
			'books.db',
			'-books',
			'books-',
			'books--db',
			'',
			'../books',
		]) {
			expect(() => defineMirror({ name, declaration: SAMPLE })).toThrow();
		}
	});

	test('names the artifact <name>.<fingerprint>.db', () => {
		const site = widgets().at('/tmp/site');
		expect(site.path).toBe(`/tmp/site/widgets.${SAMPLE_FINGERPRINT}.db`);
	});
});

describe('opening', () => {
	test('creates the current artifact, and only that artifact', () => {
		const tmp = tempDir();
		const dir = join(tmp.dir, 'company');
		const site = widgets().at(dir);

		expect(site.artifacts()).toEqual([]);
		site.open().close();

		expect(existsSync(site.path)).toBe(true);
		expect(site.artifacts()).toEqual([
			{
				fingerprint: SAMPLE_FINGERPRINT,
				filename: `widgets.${SAMPLE_FINGERPRINT}.db`,
				path: site.path,
				current: true,
			},
		]);
		tmp.cleanup();
	});

	test('read-only reports an absent artifact instead of conjuring one', () => {
		const tmp = tempDir();
		const site = widgets().at(join(tmp.dir, 'company'));
		expect(site.openReadonly()).toBeNull();
		expect(existsSync(site.path)).toBe(false);
		tmp.cleanup();
	});

	test('reopening keeps every row: nothing is dropped or migrated', () => {
		const tmp = tempDir();
		const site = widgets().at(tmp.dir);
		const first = site.open();
		first.run('CREATE TABLE t (id TEXT PRIMARY KEY);');
		first.run(`INSERT INTO t (id) VALUES ('a');`);
		first.close();

		const second = site.open();
		expect(second.query('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 });
		second.close();

		const reader = site.openReadonly();
		expect(reader?.query('SELECT count(*) AS n FROM t').get()).toEqual({
			n: 1,
		});
		reader?.close();
		tmp.cleanup();
	});
});

describe('a changed declaration', () => {
	test('names a new artifact and leaves the predecessor untouched', () => {
		const tmp = tempDir();
		const before = widgets().at(tmp.dir);
		const db = before.open();
		db.run('CREATE TABLE t (id TEXT PRIMARY KEY);');
		db.run(`INSERT INTO t (id) VALUES ('a');`);
		db.close();

		const after = widgetsV2().at(tmp.dir);
		expect(after.path).not.toBe(before.path);

		// The successor's reader sees no materialization: it will not fall back to
		// the predecessor, which stopped being authoritative the moment the shape
		// changed.
		expect(after.openReadonly()).toBeNull();

		after.open().close();
		const listed = after.artifacts();
		expect(listed.length).toBe(2);
		expect(listed.filter((a) => a.current).map((a) => a.fingerprint)).toEqual([
			after.fingerprint,
		]);
		expect(listed.filter((a) => !a.current).map((a) => a.fingerprint)).toEqual([
			before.fingerprint,
		]);

		// The predecessor's rows are still there, opened deliberately by its path.
		expect(existsSync(before.path)).toBe(true);
		const old = before.openReadonly();
		expect(old?.query('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 });
		old?.close();
		tmp.cleanup();
	});
});

describe('artifacts()', () => {
	test("lists only this mirror's files, never a sibling the app owns", () => {
		const tmp = tempDir();
		const site = widgets().at(tmp.dir);
		site.open().close();
		writeFileSync(join(tmp.dir, 'lock.db'), '');
		writeFileSync(join(tmp.dir, 'credentials.json'), '{}');
		writeFileSync(join(tmp.dir, 'companies.json'), '{}');
		writeFileSync(join(tmp.dir, `widgets.${'z'.repeat(64)}.db`), '');
		writeFileSync(join(tmp.dir, `gadgets.${SAMPLE_FINGERPRINT}.db`), '');

		expect(site.artifacts().map((a) => a.filename)).toEqual([
			`widgets.${SAMPLE_FINGERPRINT}.db`,
		]);
		tmp.cleanup();
	});

	test('is an empty site, not an error, when the directory does not exist', () => {
		const tmp = tempDir();
		expect(widgets().at(join(tmp.dir, 'nope')).artifacts()).toEqual([]);
		tmp.cleanup();
	});
});

describe('reclaim', () => {
	test('deletes one predecessor and its sidecars, and nothing else', () => {
		const tmp = tempDir();
		const before = widgets().at(tmp.dir);
		before.open().close();
		writeFileSync(`${before.path}-wal`, '');
		writeFileSync(`${before.path}-shm`, '');
		writeFileSync(join(tmp.dir, 'lock.db'), '');
		writeFileSync(join(tmp.dir, 'credentials.json'), '{}');

		const after = widgetsV2().at(tmp.dir);
		after.open().close();
		after.reclaim(before.fingerprint);

		expect(existsSync(before.path)).toBe(false);
		expect(existsSync(`${before.path}-wal`)).toBe(false);
		expect(existsSync(`${before.path}-shm`)).toBe(false);
		expect(existsSync(after.path)).toBe(true);
		expect(readdirSync(tmp.dir).sort()).toEqual(
			['credentials.json', 'lock.db', `widgets.${after.fingerprint}.db`].sort(),
		);
		tmp.cleanup();
	});

	test('refuses the current fingerprint', () => {
		const tmp = tempDir();
		const site = widgets().at(tmp.dir);
		site.open().close();
		expect(() => site.reclaim(site.fingerprint)).toThrow(/current artifact/);
		expect(existsSync(site.path)).toBe(true);
		tmp.cleanup();
	});

	test('refuses anything that is not a fingerprint', () => {
		const site = widgets().at('/tmp/site');
		for (const bad of ['', 'lock', '../../etc/passwd', 'A'.repeat(64), 'a']) {
			expect(() => site.reclaim(bad)).toThrow(/64 lowercase hex/);
		}
	});

	test('reclaiming an artifact that is already gone is a no-op', () => {
		const tmp = tempDir();
		const site = widgets().at(tmp.dir);
		site.open().close();
		expect(() => site.reclaim('b'.repeat(64))).not.toThrow();
		expect(existsSync(tmp.dir)).toBe(true);
		expect(existsSync(site.path)).toBe(true);
		tmp.cleanup();
	});
});
