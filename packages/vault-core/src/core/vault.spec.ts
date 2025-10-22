import Database from 'bun:sqlite';
import { test } from 'bun:test';
import { fail } from 'node:assert';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import {
	createTestAdapter,
	ingestSchema,
	invalidIngestData,
	makeImportFiles,
	makeIngestFile,
	TEST_ADAPTER_ID,
	testSchema,
	validIngestData,
} from '../../tests/fixtures/testAdapter';
import { jsonFormat } from '../codecs/json';
import { getVaultLedgerTag, runStartupSqlMigrations } from './migrations';
import { createVault } from './vault';

function createDatabase() {
	const sqlite = new Database(':memory:');
	const db = drizzle(sqlite);
	return { sqlite, db };
}

function createVaultInstance() {
	const { sqlite, db } = createDatabase();
	const adapter = createTestAdapter();
	const vault = createVault({
		database: db,
		adapters: [adapter],
	});
	return { sqlite, db, adapter, vault };
}

test('runStartupSqlMigrations applies schema and updates ledger', async () => {
	const { sqlite, db } = createDatabase();
	const adapter = createTestAdapter();
	try {
		const result = await runStartupSqlMigrations(
			adapter.id,
			adapter.versions,
			db,
		);
		assert.deepEqual(result.applied, ['0000']);

		// Should throw if table is not present
		await db.select().from(testSchema.test_items);

		const ledgerTag = await getVaultLedgerTag(db, adapter.id);
		assert.equal(ledgerTag, '0000');
	} finally {
		sqlite.close();
	}
});

test('ingestData stores rows and exposes them via query interface', async () => {
	const { sqlite, db, adapter, vault } = createVaultInstance();
	try {
		const file = makeIngestFile(validIngestData);
		await vault.ingestData({ adapter, file });

		const rows = await db.select().from(testSchema.test_items);
		const ingested = ingestSchema(validIngestData);
		if ('issues' in ingested) throw new Error('Ingested data is invalid');

		assert.equal(rows.length, ingested.items.length);

		const { db: queryDb, tables } = vault.getQueryInterface();
		const qiSchema = tables[TEST_ADAPTER_ID] as typeof testSchema;
		const qiRows = await queryDb.select().from(qiSchema.test_items);
		assert.equal(qiRows.length, validIngestData.items.length);
	} finally {
		sqlite.close();
	}
});

test('ingestData rejects invalid payloads', async () => {
	const { sqlite, adapter, vault } = createVaultInstance();
	try {
		const invalidFile = makeIngestFile(invalidIngestData, 'invalid.json');
		await assert.rejects(
			() => vault.ingestData({ adapter, file: invalidFile }),
			/validation/i,
		);
	} finally {
		sqlite.close();
	}
});

test('importData inserts rows when validator succeeds', async () => {
	const { sqlite, db, vault } = createVaultInstance();
	try {
		const ingested = ingestSchema(validIngestData);
		if ('issues' in ingested) fail('Ingested data is invalid');
		const files = makeImportFiles(ingested);

		await vault.importData({
			files,
			codec: jsonFormat,
		});

		const rows = await db.select().from(testSchema.test_items);
		assert.equal(rows.length, validIngestData.items.length);
	} finally {
		sqlite.close();
	}
});

test('importData propagates validator errors', async () => {
	const { vault } = createVaultInstance();
	assert.rejects(async () => {
		const ingested = ingestSchema(invalidIngestData);
		// @ts-expect-error invalid data for test
		const files = makeImportFiles(ingested);
		vault.importData({
			files,
			codec: jsonFormat,
		});
	});
});

test('smoke: ingest, export, and import round trip', async () => {
	const {
		sqlite: sourceSqlite,
		vault: sourceVault,
		adapter: sourceAdapter,
	} = createVaultInstance();
	try {
		const ingestFile = makeIngestFile(validIngestData);
		await sourceVault.ingestData({ adapter: sourceAdapter, file: ingestFile });

		const exported = await sourceVault.exportData({ codec: jsonFormat });
		const { sqlite: destSqlite, vault: destVault } = createVaultInstance();

		try {
			const importFiles = new Map<string, File>();
			for (const [path, file] of exported) {
				const contents = await file.text();
				importFiles.set(path, {
					name: file.name,
					type: file.type,
					async text() {
						return contents;
					},
				} as unknown as File);
			}

			await destVault.importData({
				files: importFiles,
				codec: jsonFormat,
			});
		} finally {
			destSqlite.close();
		}
	} finally {
		sourceSqlite.close();
	}
});
