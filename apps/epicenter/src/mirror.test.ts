/**
 * The host's half of the mirror (ADR-0271).
 *
 * Four things are worth pinning and nothing else is: that a path cannot leave
 * the folder, that a file is never readable half-written, that a pass without
 * a manifest deletes nothing, and that a write whose bytes already match does
 * not touch the file. Everything else about what a file contains is the
 * application's, because the host interprets nothing.
 */

import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMirrorPass, mirrorFolderPath } from './mirror.ts';
import { MIRROR_INDEX_FILE } from './mirror-index.ts';

const ROOT = '/Users/person/Epicenter';
const APP = 'so.epicenter.honeycrisp';

const folder = (place: string, dataId: string) =>
	mirrorFolderPath({ place, dataId, root: ROOT });

const file = (path: string, contents: string) =>
	`${JSON.stringify({ path, contents })}\n`;
const manifest = (paths: string[]) => `${JSON.stringify({ manifest: paths })}\n`;

function scratch(): string {
	return mkdtempSync(join(tmpdir(), 'epicenter-mirror-'));
}

test('a folder resolves under its place and application', () => {
	expect(folder('local', APP)).toBe(`${ROOT}/local/${APP}`);
	expect(folder('account', APP)).toBe(`${ROOT}/account/${APP}`);
});

test('a place that is not one of the two is refused', () => {
	// The top level says where data lives and there are exactly two answers.
	expect(folder('accounts', APP)).toBeUndefined();
	expect(folder('on-this-device', APP)).toBeUndefined();
	expect(folder('', APP)).toBeUndefined();
	expect(folder('..', APP)).toBeUndefined();
});

test('a data id that could not name an app directory is refused', () => {
	expect(folder('local', '..')).toBeUndefined();
	expect(folder('local', '.')).toBeUndefined();
	expect(folder('local', '')).toBeUndefined();
	expect(folder('local', 'a/b')).toBeUndefined();
});

test('a file cannot climb out of its folder', async () => {
	const root = scratch();
	const target = join(root, 'account', APP);
	// `../x.md` and `./x.md` both SPLIT into two segments, so a grammar check
	// alone admits them. Containment is what actually refuses them.
	await applyMirrorPass(
		target,
		file('../escape.md', 'no') +
			file('./escape.md', 'no') +
			file('/etc/passwd', 'no') +
			file('notes/../../escape.md', 'no') +
			file('notes/ok.md', 'yes') +
			manifest(['notes/ok.md']),
	);
	expect(readdirSync(join(target, 'notes'))).toEqual(['ok.md']);
	expect(readdirSync(join(root, 'account'))).toEqual([APP]);
});

test('only the files a render produces are accepted', async () => {
	const root = scratch();
	await applyMirrorPass(
		root,
		file('notes/abc.md', 'row') +
			file('kv.json', '{}') +
			file('notes.md', 'no') +
			file('notes/abc/def.md', 'no') +
			file('notes/abc.txt', 'no') +
			file('.DS_Store', 'no') +
			manifest(['notes/abc.md', 'kv.json']),
	);
	expect(readdirSync(root).sort()).toEqual(['kv.json', 'notes', MIRROR_INDEX_FILE]);
	expect(readdirSync(join(root, 'notes'))).toEqual(['abc.md']);
});

test('a write is atomic and leaves no staging file behind', async () => {
	const root = scratch();
	await applyMirrorPass(root, file('notes/abc.md', 'one') + manifest(['notes/abc.md']));
	expect(readFileSync(join(root, 'notes', 'abc.md'), 'utf8')).toBe('one');

	await applyMirrorPass(root, file('notes/abc.md', 'two') + manifest(['notes/abc.md']));
	expect(readFileSync(join(root, 'notes', 'abc.md'), 'utf8')).toBe('two');
	expect(readdirSync(join(root, 'notes'))).toEqual(['abc.md']);
});

test('a file whose bytes already match is not touched', async () => {
	// The point is the inode, not the clock. A rename replaces the file, so
	// rewriting unchanged bytes makes every backup tool watching the folder
	// see the whole vault as new on every pass.
	const root = scratch();
	await applyMirrorPass(root, file('notes/abc.md', 'same') + manifest(['notes/abc.md']));
	const before = statSync(join(root, 'notes', 'abc.md'));

	await applyMirrorPass(root, file('notes/abc.md', 'same') + manifest(['notes/abc.md']));
	const after = statSync(join(root, 'notes', 'abc.md'));

	expect(after.ino).toBe(before.ino);
	expect(after.mtimeMs).toBe(before.mtimeMs);
});

test('the manifest is what removes a file, and only the manifest', async () => {
	const root = scratch();
	await applyMirrorPass(
		root,
		file('notes/keep.md', 'a') +
			file('notes/gone.md', 'b') +
			manifest(['notes/keep.md', 'notes/gone.md']),
	);
	expect(readdirSync(join(root, 'notes')).sort()).toEqual(['gone.md', 'keep.md']);

	await applyMirrorPass(root, manifest(['notes/keep.md']));
	expect(readdirSync(join(root, 'notes'))).toEqual(['keep.md']);
});

test('a pass with no manifest deletes nothing', async () => {
	// A connection dropped mid-pass. Files that arrived are written and nothing
	// is removed, so the folder is stale rather than gutted.
	const root = scratch();
	await applyMirrorPass(
		root,
		file('notes/a.md', 'a') + file('notes/b.md', 'b') + manifest(['notes/a.md', 'notes/b.md']),
	);
	await applyMirrorPass(root, file('notes/a.md', 'edited'));

	expect(readdirSync(join(root, 'notes')).sort()).toEqual(['a.md', 'b.md']);
	expect(readFileSync(join(root, 'notes', 'a.md'), 'utf8')).toBe('edited');
});

test('a file a person put there is theirs', async () => {
	const root = scratch();
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, 'README.md'), 'mine');
	await applyMirrorPass(root, file('notes/a.md', 'a') + manifest(['notes/a.md']));

	// `README.md` is not a row file, so the sweep has no business with it.
	expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('mine');
});

test('a line the host cannot read costs that line, not the pass', async () => {
	const root = scratch();
	await applyMirrorPass(
		root,
		'not json\n' +
			`${JSON.stringify({ path: 'notes/a.md' })}\n` +
			file('notes/b.md', 'b') +
			manifest(['notes/a.md', 'notes/b.md']),
	);
	expect(readdirSync(join(root, 'notes'))).toEqual(['b.md']);
});

test('the index is rebuilt from what survived the sweep', async () => {
	const root = scratch();
	await applyMirrorPass(
		root,
		file('notes/a.md', '---\ntitle: "kept"\n---\n') +
			file('notes/b.md', '---\ntitle: "gone"\n---\n') +
			manifest(['notes/a.md', 'notes/b.md']),
	);
	await applyMirrorPass(root, manifest(['notes/a.md']));

	const database = new Database(join(root, MIRROR_INDEX_FILE), { readonly: true });
	try {
		const rows = database.query('SELECT path, title FROM notes').all();
		// Never a row for the file the same pass removed: the index is rebuilt
		// after the sweep, so it cannot describe something about to disappear.
		expect(rows).toEqual([{ path: 'notes/a.md', title: 'kept' }]);
	} finally {
		database.close();
	}
});
