/**
 * `tables.sqlite`, built from the files beside it (ADR-0271).
 *
 * What is worth pinning is that an agent can ask a real question and get paths
 * back, and that the index carries what a declaration would have narrowed away.
 * Nothing here opens a store, and nothing here decodes a CRDT: the input is
 * Markdown the host already has on disk.
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexMirrorFolder, MIRROR_INDEX_FILE } from './mirror-index.ts';
import { writeMirrorFile } from './mirror.ts';

async function folderWith(files: Record<string, string>): Promise<string> {
	const folder = mkdtempSync(join(tmpdir(), 'epicenter-index-'));
	for (const [path, contents] of Object.entries(files)) {
		await writeMirrorFile(join(folder, path), contents);
	}
	await indexMirrorFolder(folder);
	return folder;
}

const rowFile = (fields: Record<string, string>, body = '') =>
	['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---', '', body]
		.join('\n')
		.trimEnd() + '\n';

test('an agent can ask for structure and get paths back', async () => {
	const folder = await folderWith({
		'kv.json': '{"theme":"dark"}',
		'notes/aaaaaaaaaaaaaaaaaaaaaaaa.md': rowFile(
			{ title: '"Groceries"', pinned: 'true', tags: '["food","home"]' },
			'# Groceries\n\nbuy milk',
		),
		'notes/bbbbbbbbbbbbbbbbbbbbbbbb.md': rowFile({
			title: '"Reading list"',
			pinned: 'false',
			tags: '[]',
		}),
		'folders/cccccccccccccccccccccccc.md': rowFile({ name: '"Inbox"' }),
	});
	try {
		const database = new Database(join(folder, MIRROR_INDEX_FILE), {
			readonly: true,
		});
		try {
			expect(
				database
					.query<{ path: string }, []>(
						`SELECT path FROM notes WHERE pinned = 1`,
					)
					.all(),
			).toEqual([{ path: 'notes/aaaaaaaaaaaaaaaaaaaaaaaa.md' }]);

			// The prose is deliberately not here. SQL answers structure and hands
			// back a path; the file beside it answers text.
			expect(
				database.query(`SELECT * FROM notes LIMIT 1`).all()[0],
			).not.toHaveProperty('body');

			// A compound value is its JSON, so `json_each` reads it.
			expect(
				database
					.query<{ value: string }, []>(
						`SELECT value FROM notes, json_each(notes.tags) ORDER BY value`,
					)
					.all()
					.map(({ value }) => value),
			).toEqual(['food', 'home']);

			expect(
				database.query(`SELECT name FROM folders`).all(),
			).toEqual([{ name: 'Inbox' }]);
		} finally {
			database.close();
		}
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

test('a field the declaration dropped is in the index, because nothing narrows here', async () => {
	// The host holds no definition, so there is nothing on this side that could
	// have decided a value was not worth carrying.
	const folder = await folderWith({
		'notes/aaaaaaaaaaaaaaaaaaaaaaaa.md': rowFile({ title: '"one"' }),
		'notes/bbbbbbbbbbbbbbbbbbbbbbbb.md': rowFile({
			title: '"two"',
			legacy: '"kept"',
		}),
	});
	try {
		const database = new Database(join(folder, MIRROR_INDEX_FILE), {
			readonly: true,
		});
		try {
			// The union of every key the files carry, not the first row's shape:
			// the legacy field lives on one note, and which note sorts first must
			// not decide whether the column exists.
			expect(
				database
					.query<{ title: string }, []>(
						`SELECT title FROM notes WHERE legacy = 'kept'`,
					)
					.all(),
			).toEqual([{ title: 'two' }]);
		} finally {
			database.close();
		}
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

test('rebuilding replaces the index whole', async () => {
	const folder = await folderWith({
		'notes/aaaaaaaaaaaaaaaaaaaaaaaa.md': rowFile({ title: '"before"' }),
	});
	try {
		rmSync(join(folder, 'notes', 'aaaaaaaaaaaaaaaaaaaaaaaa.md'));
		await writeMirrorFile(
			join(folder, 'notes', 'bbbbbbbbbbbbbbbbbbbbbbbb.md'),
			rowFile({ title: '"after"' }),
		);
		await indexMirrorFolder(folder);

		const database = new Database(join(folder, MIRROR_INDEX_FILE), {
			readonly: true,
		});
		try {
			expect(
				database
					.query<{ title: string }, []>(`SELECT title FROM notes`)
					.all(),
			).toEqual([{ title: 'after' }]);
		} finally {
			database.close();
		}
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});
