/**
 * `tables.sqlite`: the folder, queryable (ADR-0271).
 *
 * A Markdown vault is the right shape for reading one note and the wrong shape
 * for asking about all of them. `rg` answers "which notes mention this"; it
 * does not answer "pinned notes in this folder from last week." So the folder
 * carries an index beside it, read-only, for whoever is pointed at it.
 *
 * ## What it is derived from, and why that matters
 *
 * From the FILES, not from the store. The host holds no workspace, opens no
 * store, and never decodes a CRDT update: it reads the Markdown the application
 * already rendered and re-shapes it. That is what keeps the index from being a
 * third rendering that could disagree with the folder. It cannot disagree,
 * because it is made of it.
 *
 * ```txt
 * store ──render──▶ .md files ──index──▶ tables.sqlite
 *        one way              one way
 * ```
 *
 * Reading a file's contents to build another derived artifact is not the seam
 * ADR-0271 guards. What is forbidden is a file's contents reaching a ROW: that
 * is ADR-0207's write direction, and receipts and three-way merges grow out of
 * it. Nothing here touches the store, and a corrupt index is repaired by
 * deleting it.
 *
 * ## Scalars, and a path
 *
 * Frontmatter and a `path` column, never the prose. An agent asks SQL for
 * structure, gets paths back, and reads those files for text. Carrying the
 * bodies here would duplicate the whole vault to answer questions `rg` already
 * answers better.
 *
 * Columns come from the keys the files actually carry, so a field an older
 * release wrote and this one no longer declares is in the index, and a
 * nonconforming row is too, with its raw values. There is no declaration on
 * this side to narrow anything, which is the artifact rule holding by
 * construction rather than by care.
 *
 * Values are stored as they arrive from JSON: strings, numbers and booleans as
 * themselves, and anything compound as its JSON text. Types are not declared,
 * for the reason the superseded projection gave: a field is nullable or
 * compound as often as not, and a narrow column type would buy nothing and cost
 * a mapping that has to be right for every expression.
 */

import { Database } from 'bun:sqlite';
import { readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRowFile, parseRowPath } from '@epicenter/data/artifact/format';

/** The index's name inside a workspace's folder. */
export const MIRROR_INDEX_FILE = 'tables.sqlite';

type IndexedRow = { rowId: string; path: string; fields: Record<string, unknown> };

/**
 * Rebuild one workspace's index from the files beside it.
 *
 * Whole, every time, for the reason the render is whole: an index that patches
 * is only as correct as its knowledge of what changed, and this one can simply
 * read what is there. It is fast because it reads frontmatter and skips bodies.
 *
 * Staged and renamed like every other mirror write, so an agent never opens a
 * half-written database.
 *
 * Takes the paths rather than listing them, because the only caller has just
 * finished sweeping and knows exactly what survived. Listing again here would
 * be a second answer to a question already answered, and the two could differ.
 */
export async function indexMirrorFolder(
	absoluteFolder: string,
	paths: readonly string[],
): Promise<void> {
	const tables = new Map<string, IndexedRow[]>();
	for (const path of paths) {
		const at = parseRowPath(path);
		if (at === undefined) continue;
		let text: string;
		try {
			text = await readFile(join(absoluteFolder, path), 'utf8');
		} catch {
			// A file that vanished between the listing and the read is a row that
			// was deleted mid-index. The next pass has the truth.
			continue;
		}
		const parsed = parseRowFile(text);
		if (parsed === undefined) continue;
		const rows = tables.get(at.table) ?? [];
		rows.push({ rowId: at.rowId, path, fields: parsed.fields });
		tables.set(at.table, rows);
	}

	const staged = join(absoluteFolder, `${MIRROR_INDEX_FILE}.epicenter-tmp`);
	await rm(staged, { force: true });
	const database = new Database(staged, { create: true });
	try {
		for (const [table, rows] of tables) {
			writeTable(database, table, rows);
		}
	} finally {
		database.close();
	}
	await rename(staged, join(absoluteFolder, MIRROR_INDEX_FILE));
}

/**
 * One relation per table: `id`, `path`, and the union of every key its files
 * carry.
 *
 * The union rather than the first row's keys, because a field an older release
 * wrote lives on some rows and not others, and taking the first row's shape
 * would drop it from the index depending on which note happened to sort first.
 */
function writeTable(
	database: Database,
	table: string,
	rows: readonly IndexedRow[],
): void {
	const columns = [...new Set(rows.flatMap(({ fields }) => Object.keys(fields)))]
		.filter((name) => name !== 'id' && name !== 'path')
		.sort();
	// The names are quoted, and the address grammar already refused anything
	// that is not a bare identifier, so the quoting is defence rather than
	// permission (`packages/data/src/definition/addresses.ts`).
	const declared = ['"id"', '"path"', ...columns.map((name) => `"${name}"`)];
	database.run(
		`CREATE TABLE "${table}" (${declared.map((name) => `${name} ANY`).join(', ')}) STRICT`,
	);
	const insert = database.prepare(
		`INSERT INTO "${table}" (${declared.join(', ')}) VALUES (${declared.map(() => '?').join(', ')})`,
	);
	const insertAll = database.transaction((all: readonly IndexedRow[]) => {
		for (const { rowId, path, fields } of all) {
			insert.run(rowId, path, ...columns.map((name) => cell(fields[name])));
		}
	});
	insertAll(rows);
}

/**
 * One frontmatter value as SQLite holds it.
 *
 * A scalar is itself; a boolean is 0 or 1, because SQLite has no boolean and
 * every SQL dialect's `WHERE pinned = 1` expects the integer; anything
 * compound is its JSON text, which `json_extract` reads and a person can see.
 */
function cell(value: unknown): string | number | null {
	if (value === undefined || value === null) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'number' || typeof value === 'string') return value;
	return JSON.stringify(value);
}
