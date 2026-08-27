/**
 * The host's file sink for the mirror (ADR-0271).
 *
 * Two things are worth pinning here and nothing else is: that a path cannot
 * leave the root, and that a file is never readable half-written. Everything
 * else about the mirror is the application's, because the host interprets
 * nothing.
 */

import { expect, test } from 'bun:test';
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	listMirrorFolder,
	mirrorFilePath,
	mirrorFolderPath,
	removeMirrorFile,
	writeMirrorFile,
} from './mirror.ts';

const ROOT = '/Users/person/Epicenter';
const APP = 'so.epicenter.honeycrisp';

const path = (workspace: string, definitionId: string, file: string) =>
	mirrorFilePath({ workspace, definitionId, path: file, root: ROOT });

test('a row file resolves under its workspace and application', () => {
	expect(path('account', APP, 'notes/aaaaaaaaaaaaaaaaaaaaaaaa.md')).toBe(
		`${ROOT}/account/${APP}/notes/aaaaaaaaaaaaaaaaaaaaaaaa.md`,
	);
	expect(path('on-this-device', APP, 'kv.json')).toBe(
		`${ROOT}/on-this-device/${APP}/kv.json`,
	);
});

test('a workspace that is not one of the two is refused', () => {
	// The top level says where data lives and there are exactly two answers.
	expect(path('accounts', APP, 'kv.json')).toBeUndefined();
	expect(path('', APP, 'kv.json')).toBeUndefined();
	expect(path('..', APP, 'kv.json')).toBeUndefined();
});

test('a path cannot climb out of the root', () => {
	// Refused rather than sanitized. The address grammar means a real path never
	// looks like this, so anything that does is not a path to clean up into
	// something adjacent; it is a request that was never going to be honoured.
	expect(path('account', '..', 'kv.json')).toBeUndefined();
	expect(path('account', '.', 'kv.json')).toBeUndefined();
	expect(path('account', APP, '../../../etc/passwd')).toBeUndefined();
	expect(path('account', APP, '/etc/passwd')).toBeUndefined();
	expect(path('account', APP, 'notes/../../escape.md')).toBeUndefined();
});

test('only the files a render produces are accepted', () => {
	expect(path('account', APP, 'notes/abc.md')).toBeDefined();
	expect(path('account', APP, 'kv.json')).toBeDefined();
	// Not a row file: a bare name, a third segment, a different extension.
	expect(path('account', APP, 'notes.md')).toBeUndefined();
	expect(path('account', APP, 'notes/abc/def.md')).toBeUndefined();
	expect(path('account', APP, 'notes/abc.txt')).toBeUndefined();
	expect(path('account', APP, '.DS_Store')).toBeUndefined();
});

test('a write is atomic, and leaves no staging file behind', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-mirror-'));
	try {
		const target = join(root, 'account', APP, 'notes', 'abc.md');
		await writeMirrorFile(target, '---\ntitle: "one"\n---\n');
		expect(readFileSync(target, 'utf8')).toBe('---\ntitle: "one"\n---\n');

		// An overwrite replaces the file whole. What must never exist between the
		// two is a readable truncated note, which is why the write stages and
		// renames rather than opening the target for writing.
		await writeMirrorFile(target, '---\ntitle: "two"\n---\n');
		expect(readFileSync(target, 'utf8')).toBe('---\ntitle: "two"\n---\n');
		expect(readdirSync(join(root, 'account', APP, 'notes'))).toEqual([
			'abc.md',
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('removing a file that is not there is success', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-mirror-'));
	try {
		const target = join(root, 'account', APP, 'notes', 'gone.md');
		// The mirror's job is that the file is absent, not that this call is the
		// one that removed it: a deleted row is asked about on every commit that
		// touched it, and a re-render after a manual delete must not fail.
		await removeMirrorFile(target);
		await writeMirrorFile(target, 'x');
		await removeMirrorFile(target);
		await removeMirrorFile(target);
		expect(readdirSync(join(root, 'account', APP, 'notes'))).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a folder lists the files a render produced, and nothing else', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-mirror-'));
	try {
		const folder = mirrorFolderPath({
			workspace: 'account',
			definitionId: APP,
			root,
		});
		if (folder === undefined) throw new Error('the folder should resolve');
		expect(await listMirrorFolder(folder)).toEqual([]);

		await writeMirrorFile(join(folder, 'kv.json'), '{}');
		await writeMirrorFile(join(folder, 'notes', 'abc.md'), 'x');
		await writeMirrorFile(join(folder, 'folders', 'def.md'), 'y');
		// A person's own file in their own folder is theirs, so a render never
		// counts it and never removes it.
		await writeMirrorFile(join(folder, 'notes', 'ghi.md'), 'z');
		writeFileSync(join(folder, 'README.md'), 'mine');

		expect((await listMirrorFolder(folder)).sort()).toEqual([
			'folders/def.md',
			'kv.json',
			'notes/abc.md',
			'notes/ghi.md',
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
