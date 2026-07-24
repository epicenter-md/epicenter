import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { isStorageUpgradeRequiredError } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import {
	initializeLocalWorkspaceStorage,
	readLocalRow,
} from './local-workspace-storage.js';

test('fresh local storage owns only scalar rows at the current version', () => {
	const database = new Database(':memory:');
	try {
		const sqlite = createBunSqliteAdapter(database);
		initializeLocalWorkspaceStorage(sqlite);
		expect(
			database
				.query<{ name: string }, []>(
					`SELECT name FROM sqlite_master WHERE type = 'table'
					 AND name NOT LIKE 'sqlite_%' ORDER BY name`,
				)
				.all(),
		).toEqual([{ name: 'rows' }]);
		expect(database.query('PRAGMA user_version').get()).toEqual({
			user_version: 3,
		});
		// Reopening the same version is an ordinary no-op.
		initializeLocalWorkspaceStorage(sqlite);
		sqlite.run(
			`INSERT INTO rows(table_key, row_id, fields_json) VALUES (?, ?, ?)`,
			['notes', 'note-1', '{"title":"kept row"}'],
		);
		expect(readLocalRow(sqlite, 'notes', 'note-1')).toEqual({
			title: 'kept row',
		});
	} finally {
		database.close();
	}
});

test('any other stored version fails loudly instead of migrating', () => {
	for (const version of [1, 2, 4]) {
		const database = new Database(':memory:');
		try {
			database.exec(`PRAGMA user_version = ${version}`);
			let failure: unknown;
			try {
				initializeLocalWorkspaceStorage(createBunSqliteAdapter(database));
			} catch (cause) {
				failure = cause;
			}
			expect(isStorageUpgradeRequiredError(failure)).toBe(true);
			expect(database.query('PRAGMA user_version').get()).toEqual({
				user_version: version,
			});
		} finally {
			database.close();
		}
	}
});

test('version zero with existing storage refuses without changing bytes', () => {
	const database = new Database(':memory:');
	try {
		database.exec(`
			CREATE TABLE legacy_rows(value TEXT NOT NULL);
			INSERT INTO legacy_rows VALUES ('preserve me');
		`);
		let failure: unknown;
		try {
			initializeLocalWorkspaceStorage(createBunSqliteAdapter(database));
		} catch (cause) {
			failure = cause;
		}
		expect(isStorageUpgradeRequiredError(failure)).toBe(true);
		expect(database.query('SELECT value FROM legacy_rows').all()).toEqual([
			{ value: 'preserve me' },
		]);
		expect(database.query('PRAGMA user_version').get()).toEqual({
			user_version: 0,
		});
	} finally {
		database.close();
	}
});

test('current marker with a malformed rows schema refuses without repair', () => {
	const database = new Database(':memory:');
	try {
		database.exec(`
			CREATE TABLE rows(table_key TEXT, legacy_payload TEXT);
			INSERT INTO rows VALUES ('notes', 'preserve me');
			PRAGMA user_version = 3;
		`);
		let failure: unknown;
		try {
			initializeLocalWorkspaceStorage(createBunSqliteAdapter(database));
		} catch (cause) {
			failure = cause;
		}
		expect(isStorageUpgradeRequiredError(failure)).toBe(true);
		expect(database.query('SELECT * FROM rows').all()).toEqual([
			{ table_key: 'notes', legacy_payload: 'preserve me' },
		]);
	} finally {
		database.close();
	}
});
