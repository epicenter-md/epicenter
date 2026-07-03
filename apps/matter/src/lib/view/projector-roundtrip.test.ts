/**
 * The JS half of the editable-views loop, end to end against a real SQLite engine.
 *
 * The Rust `disk_edit_reprojects_through_scan_and_mirror` test (src-tauri/src/watch.rs) proves the
 * filesystem + watcher + mirror commands. This proves the piece Rust stubs: the matter-core
 * projector. It runs the SAME pipeline the live app runs on every batch:
 *
 *   parseEntry -> loadContract -> buildView -> projectToSqlite -> (SQLite) -> buildStemQuery -> query
 *
 * but with `bun:sqlite` standing in for the Rust `write_mirror`/`query_mirror` commands (both are
 * thin wrappers that run exactly this SQL). So a status edit moving a card between board buckets is
 * verified here without a window, a watcher, or Tauri. Group-by buckets in the future board view are
 * just this query with `where: "status = '<bucket>'"`.
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	buildStemQuery,
	buildView,
	loadContract,
	parseEntry,
	projectToSqlite,
	type Row,
} from '@epicenter/matter-core';

const TABLE = 'tasks';
// `searchable` defaults to body + text fields, so the projector also emits an FTS5 index and trigger;
// bun:sqlite ships with FTS5, so the real schema runs unmodified here.
const CONTRACT = JSON.stringify({ fields: { status: { type: 'string' } } });

/** Parse one card's markdown into a Row (the parse the watcher's Content delta feeds). */
function card(stem: string, status: string): Row {
	const { data, error } = parseEntry(
		`${stem}.md`,
		`---\nstatus: ${status}\n---\n# ${stem}\n`,
	);
	if (error)
		throw new Error(`fixture ${stem} failed to parse: ${error.message}`);
	return data;
}

/** Project the rows into a fresh SQLite db, exactly as a settled watcher batch would. */
function project(db: Database, rows: Row[]): void {
	const view = buildView(rows, loadContract(CONTRACT));
	if (view.mode !== 'typed')
		throw new Error('fixture contract should be typed');
	const {
		schema,
		insert,
		rows: tuples,
	} = projectToSqlite(TABLE, view.contract, view.conformance);
	// The schema is a multi-statement DROP + CREATE script (base table + FTS5 index + trigger, whose
	// body carries its own semicolons), so it runs as one script, not per-split-statement.
	db.run(schema);
	const prepared = db.query(insert);
	for (const tuple of tuples) prepared.run(...(tuple as never[]));
}

/** The stems in one board bucket: the exact query a board column issues. */
function bucket(db: Database, status: string): string[] {
	const sql = buildStemQuery(TABLE, {
		where: `status = '${status}'`,
		sort: { column: 'stem', dir: 'asc' },
	});
	return (db.query(sql).all() as { stem: string }[]).map((r) => r.stem);
}

test('a status edit moves a card between board buckets through the projector', () => {
	const db = new Database(':memory:');

	// Two cards: one todo, one done.
	project(db, [card('card-a', 'todo'), card('card-b', 'done')]);
	expect(bucket(db, 'todo')).toEqual(['card-a']);
	expect(bucket(db, 'done')).toEqual(['card-b']);

	// The drag: card-a's status is rewritten to done on disk, the folder reprojects.
	project(db, [card('card-a', 'done'), card('card-b', 'done')]);
	expect(bucket(db, 'todo')).toEqual([]);
	expect(bucket(db, 'done')).toEqual(['card-a', 'card-b']);
});
