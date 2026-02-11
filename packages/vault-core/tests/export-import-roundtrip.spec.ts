import Database from 'bun:sqlite';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { jsonFormat } from '../src/codecs/json';
import { defineAdapter } from '../src/core/adapter';
import {
	defineTransformRegistry,
	defineVersions,
	runStartupSqlMigrations,
} from '../src/core/migrations';
import { createVault } from '../src/core/vault';

function createDatabase() {
	const sqlite = new Database(':memory:');
	const db = drizzle(sqlite);
	return { sqlite, db };
}

const roundtripProfiles = sqliteTable('roundtrip_profiles', {
	id: text('id').primaryKey(),
	birthdate: integer('birthdate', { mode: 'timestamp' }),
	verifiedBirthdate: integer('verified_birthdate', { mode: 'timestamp' }),
	verificationState: text('verification_state').notNull().default(''),
	verificationMethod: text('verification_method').notNull().default(''),
});

const roundtripSchema = {
	roundtrip_profiles: roundtripProfiles,
};

const roundtripVersions = defineVersions({
	tag: '0000',
	sql: [
		`CREATE TABLE IF NOT EXISTS roundtrip_profiles (
			id TEXT PRIMARY KEY,
			birthdate INTEGER,
			verified_birthdate INTEGER,
			verification_state TEXT NOT NULL DEFAULT '',
			verification_method TEXT NOT NULL DEFAULT ''
		);`,
	],
});

const roundtripTransforms = defineTransformRegistry({});

const createRoundtripAdapter = defineAdapter(() => ({
	id: 'roundtrip',
	schema: roundtripSchema,
	versions: roundtripVersions,
	transforms: roundtripTransforms,
}));

test('export/import roundtrip preserves null and Date columns', async () => {
	const adapter = createRoundtripAdapter();
	const sampleDate = new Date('2024-04-05T12:00:00Z');

	const { sqlite: sourceSqlite, db: sourceDb } = createDatabase();
	let exported: Map<string, File>;
	try {
		await runStartupSqlMigrations(adapter.id, adapter.versions, sourceDb);
		await sourceDb.insert(roundtripProfiles).values({
			id: 'singleton',
			birthdate: null,
			verifiedBirthdate: sampleDate,
			verificationState: '',
			verificationMethod: '',
		});

		const sourceVault = createVault({
			database: sourceDb,
			adapters: [adapter],
		});
		exported = await sourceVault.exportData({ codec: jsonFormat });
	} finally {
		sourceSqlite.close();
	}

	const { sqlite: targetSqlite, db: targetDb } = createDatabase();
	try {
		const targetVault = createVault({
			database: targetDb,
			adapters: [adapter],
		});

		await targetVault.importData({ files: exported, codec: jsonFormat });

		const rows = await targetDb.select().from(roundtripProfiles);
		assert.equal(rows.length, 1);
		const row = rows[0];
		assert.equal(row?.id, 'singleton');
		assert.equal(row?.birthdate, null);
		assert.ok(row?.verifiedBirthdate instanceof Date);
		assert.equal(
			row?.verifiedBirthdate?.toISOString(),
			sampleDate.toISOString(),
		);
		assert.equal(row?.verificationState, '');
		assert.equal(row?.verificationMethod, '');
	} finally {
		targetSqlite.close();
	}
});
