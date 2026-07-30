/**
 * Bun Epicenter opener filesystem contract.
 *
 * A fresh install has no application data directory at all. The opener is the
 * component that decides where the database file lives, so it is the one that
 * makes the place it lives, for every spelling of that location.
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { field } from '@epicenter/field';
import { defineLens, defineTable } from '@epicenter/lens';
import { expectOk } from 'wellcrafted/testing';

import { EPICENTER_FILE_NAME, openBunEpicenter } from './bun.js';

const notesLens = defineLens({
	namespace: 'so.epicenter.tests',
	tables: { notes: defineTable({ fields: { title: field.string() } }) },
	values: {},
});

/** A path under a temporary root whose intermediate directories never existed. */
function unwrittenRoot() {
	const parent = mkdtempSync(join(tmpdir(), 'epicenter-fresh-'));
	return {
		parent,
		// Two levels deep, so a single non-recursive mkdir would not be enough.
		directory: join(parent, 'profile', 'data'),
		[Symbol.dispose]() {
			rmSync(parent, { recursive: true, force: true });
		},
	};
}

test('a directory that was never created still opens and persists', async () => {
	using root = unwrittenRoot();
	expect(existsSync(root.directory)).toBeFalse();

	const first = await openBunEpicenter({ directory: root.directory });
	const created = await first.bind(notesLens).tables.notes.create({
		title: 'first boot',
	});
	await first[Symbol.asyncDispose]();

	expect(existsSync(join(root.directory, EPICENTER_FILE_NAME))).toBeTrue();

	await using reopened = await openBunEpicenter({ directory: root.directory });
	expect(
		expectOk(await reopened.bind(notesLens).tables.notes.get(created.id)),
	).toEqual(created);
});

test('a path whose parent directory does not exist opens the same way', async () => {
	using root = unwrittenRoot();
	// The desktop owner resolves a path up front so inspection can open the same
	// file, so the path spelling is the one a real fresh profile boots through.
	const path = join(root.directory, EPICENTER_FILE_NAME);
	expect(existsSync(root.directory)).toBeFalse();

	await using epicenter = await openBunEpicenter({ path });
	const created = await epicenter.bind(notesLens).tables.notes.create({
		title: 'path boot',
	});
	expect(
		expectOk(await epicenter.bind(notesLens).tables.notes.get(created.id)),
	).toEqual(created);
});
