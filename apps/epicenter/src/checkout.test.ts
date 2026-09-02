/**
 * The host's half of the working copy (ADR-0337).
 *
 * Five things are worth pinning and nothing else is: that a path cannot leave
 * the folder, that a file is never readable half-written, that a checkout is
 * complete so what it does not name goes, that a person's own files survive
 * both directions, and that a write whose bytes already match does not touch
 * the file. Everything else about what a file CONTAINS is the application's,
 * because the host interprets nothing.
 */

import { expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MANIFEST_PATH } from '@epicenter/data/artifact/checkout';
import { checkoutFolderPath, readCheckout, writeCheckout } from './checkout.ts';

const ROOT = '/Users/person/Epicenter';
const APP = 'so.epicenter.honeycrisp';

const folder = (dataId: string) => checkoutFolderPath({ dataId, root: ROOT });

const file = (path: string, contents: string) =>
	`${JSON.stringify({ path, contents })}\n`;

function scratch(): string {
	return mkdtempSync(join(tmpdir(), 'epicenter-checkout-'));
}

function paths(ndjson: string): string[] {
	return ndjson
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => (JSON.parse(line) as { path: string }).path)
		.sort();
}

test('a folder is the data id, one segment under the root', () => {
	// And nothing under that. The `local`/`account` segment went with the device
	// store: there is one store per data id, so there is one folder.
	expect(folder(APP)).toBe(`${ROOT}/${APP}`);
});

test('a data id that could not name an app directory is refused', () => {
	expect(folder('..')).toBeUndefined();
	expect(folder('.')).toBeUndefined();
	expect(folder('')).toBeUndefined();
	expect(folder('a/b')).toBeUndefined();
});

test('a file cannot climb out of its folder', async () => {
	const root = scratch();
	const target = join(root, APP);
	// `../x.md` and `./x.md` both SPLIT into two segments, so a grammar check
	// alone admits them. Containment is what actually refuses them.
	await writeCheckout(
		target,
		file('../escape.md', 'no') +
			file('./escape.md', 'no') +
			file('/etc/passwd', 'no') +
			file('notes/../../escape.md', 'no') +
			file('notes/ok.md', 'yes'),
	);
	// `.epicenter/` is the lock's home, not an escaped file.
	expect(readdirSync(root).sort()).toEqual(['.epicenter', APP]);
	expect(readFileSync(join(target, 'notes/ok.md'), 'utf8')).toBe('yes');
});

test('a checkout is complete, so what it does not name is gone', async () => {
	const target = join(scratch(), APP);
	await writeCheckout(
		target,
		file('notes/a.md', 'a') + file('notes/b.md', 'b') + file('kv.json', '{}'),
	);
	await writeCheckout(target, file('notes/a.md', 'a2') + file('kv.json', '{}'));

	expect(readFileSync(join(target, 'notes/a.md'), 'utf8')).toBe('a2');
	expect(readdirSync(join(target, 'notes'))).toEqual(['a.md']);
});

test("a person's own files survive a checkout, and are never handed back", async () => {
	// The folder root is also where somebody puts a note to themselves, and
	// where a pull writes the `AGENTS.md` an agent reads. Neither is a row.
	const target = join(scratch(), APP);
	await writeCheckout(target, file('notes/a.md', 'a'));
	writeFileSync(join(target, 'README.md'), 'mine');
	mkdirSync(join(target, 'scratch'));
	writeFileSync(join(target, 'scratch/idea.txt'), 'also mine');

	await writeCheckout(target, file('notes/b.md', 'b'));
	expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('mine');
	expect(readFileSync(join(target, 'scratch/idea.txt'), 'utf8')).toBe(
		'also mine',
	);
	expect(paths(await readCheckout(target))).toEqual(['notes/b.md']);
});

test('the manifest is written and read like any other file, and never parsed', async () => {
	const target = join(scratch(), APP);
	// Deliberately not valid JSON. The host has no opinion about what is in a
	// file: whether this manifest can be read is the application's question.
	await writeCheckout(
		target,
		file('.epicenter/manifest.json', 'not json') + file('notes/a.md', 'a'),
	);
	expect(paths(await readCheckout(target))).toEqual([
		'.epicenter/manifest.json',
		'notes/a.md',
	]);
});

test('a write whose bytes already match does not touch the file', async () => {
	// A rename replaces the inode, so rewriting an unchanged file makes Time
	// Machine, rclone, and Spotlight see the whole folder as new every pull.
	const target = join(scratch(), APP);
	await writeCheckout(target, file('notes/a.md', 'a'));
	const before = statSync(join(target, 'notes/a.md'));

	await Bun.sleep(10);
	await writeCheckout(target, file('notes/a.md', 'a'));
	const after = statSync(join(target, 'notes/a.md'));
	expect(after.mtimeMs).toBe(before.mtimeMs);
});

test('reading a folder that was never pulled answers empty rather than failing', async () => {
	// A place with no checkout has no stale files by definition, and asking is
	// how `pull` learns the folder is clean on a fresh machine.
	expect(await readCheckout(join(scratch(), APP))).toBe('');
});

test('an interrupted checkout leaves the manifest describing the previous one', async () => {
	// The order is the recovery. A directory where the next checkout wants a
	// file makes the write throw partway; the manifest is written last, so what
	// survives describes the checkout BEFORE this one and the next `pull`
	// compares against it, calls the folder dirty, and shows a person what is
	// there.
	const target = join(scratch(), APP);
	await writeCheckout(
		target,
		file('notes/a.md', 'a') + file(MANIFEST_PATH, '{"generation":1}'),
	);
	mkdirSync(join(target, 'notes/b.md'));

	await expect(
		writeCheckout(
			target,
			file('notes/b.md', 'b') + file(MANIFEST_PATH, '{"generation":2}'),
		),
	).rejects.toThrow();
	expect(readFileSync(join(target, MANIFEST_PATH), 'utf8')).toBe(
		'{"generation":1}',
	);
});

test('the folder claim is not a sibling an app id could name', async () => {
	// `so.epicenter.honeycrisp.epicenter-lock` is a legal data id, so a lock
	// beside the folder it guards is another app's folder: that app would be
	// refused forever, and releasing the lock would delete it.
	const root = scratch();
	await writeCheckout(join(root, APP), file('notes/a.md', 'a'));
	expect(readdirSync(root).sort()).toEqual(['.epicenter', APP]);
});

test('two writers do not interleave, and the second says so', async () => {
	const target = join(scratch(), APP);
	mkdirSync(join(dirname(target), '.epicenter', 'locks'), { recursive: true });
	mkdirSync(join(dirname(target), '.epicenter', 'locks', APP));
	await expect(writeCheckout(target, file('notes/a.md', 'a'))).rejects.toThrow(
		/already being written/,
	);
});
