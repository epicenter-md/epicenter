import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	isStorageUpgradeRequiredError,
	type SqliteDatabase,
} from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { inspectCurrentStateReplicaSchema } from './current-state-replica.js';
import { initializeWorkspaceStorageSchema } from './workspace-storage-schema.js';

function expectUpgradeRequired(open: () => unknown): void {
	let failure: unknown;
	try {
		open();
	} catch (cause) {
		failure = cause;
	}
	expect(isStorageUpgradeRequiredError(failure)).toBe(true);
}

for (const kind of ['device', 'account'] as const) {
	test(`${kind} storage refuses an extra object without cleanup`, () => {
		const sqlite = new Database(':memory:');
		const database = createBunSqliteAdapter(sqlite);
		try {
			initializeWorkspaceStorageSchema(database, kind);
			if (kind === 'account') {
				database.run(
					'CREATE TABLE acquisition_scratch_rows(sentinel TEXT NOT NULL)',
				);
				database.run(
					"INSERT INTO acquisition_scratch_rows VALUES ('preserved')",
				);
			}
			database.run('CREATE TABLE unrelated(sentinel TEXT NOT NULL)');
			database.run("INSERT INTO unrelated VALUES ('preserved')");

			expectUpgradeRequired(() =>
				initializeWorkspaceStorageSchema(database, kind),
			);
			expect(database.all('SELECT * FROM unrelated')).toEqual([
				{ sentinel: 'preserved' },
			]);
			if (kind === 'account') {
				expect(database.all('SELECT * FROM acquisition_scratch_rows')).toEqual([
					{ sentinel: 'preserved' },
				]);
			}
		} finally {
			sqlite.close();
		}
	});
}

test('Account schema comparison preserves CHECK literal case', () => {
	const sqlite = new Database(':memory:');
	const database = createBunSqliteAdapter(sqlite);
	try {
		initializeWorkspaceStorageSchema(database, 'account');
		const schema = database.all<{ sql: string }>(
			"SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'intents'",
		)[0]?.sql;
		expect(schema).toBeDefined();
		database.run('ALTER TABLE intents RENAME TO intents_old');
		database.run((schema ?? '').replace("'create'", "'CREATE'"));
		database.run('DROP TABLE intents_old');
		expectUpgradeRequired(() => inspectCurrentStateReplicaSchema(database));
	} finally {
		sqlite.close();
	}
});

test('Account storage refuses a non-table scratch object before cleanup', () => {
	const sqlite = new Database(':memory:');
	const database = createBunSqliteAdapter(sqlite);
	try {
		initializeWorkspaceStorageSchema(database, 'account');
		database.run(
			'CREATE VIEW acquisition_scratch_rows AS SELECT 1 AS sentinel',
		);
		expectUpgradeRequired(() =>
			initializeWorkspaceStorageSchema(database, 'account'),
		);
		expect(
			database.all<{ type: string }>(
				"SELECT type FROM sqlite_schema WHERE name = 'acquisition_scratch_rows'",
			),
		).toEqual([{ type: 'view' }]);
	} finally {
		sqlite.close();
	}
});

test('empty workspace schema creation is atomic', () => {
	const sqlite = new Database(':memory:');
	const base = createBunSqliteAdapter(sqlite);
	const database: SqliteDatabase = {
		...base,
		run(sql, parameters) {
			if (sql.startsWith('CREATE INDEX workspace_document_updates_address')) {
				throw new Error('injected document schema failure');
			}
			base.run(sql, parameters);
		},
	};
	try {
		expect(() => initializeWorkspaceStorageSchema(database, 'device')).toThrow(
			'injected document schema failure',
		);
		expect(
			base.all<{ name: string }>(
				`SELECT name FROM sqlite_schema
				 WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'`,
			),
		).toEqual([]);
		expect(
			base.all<{ user_version: number }>('PRAGMA user_version')[0]
				?.user_version,
		).toBe(0);
	} finally {
		sqlite.close();
	}
});
