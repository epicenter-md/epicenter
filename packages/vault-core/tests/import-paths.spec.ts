import Database from 'bun:sqlite';
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { jsonFormat } from '../src/codecs/json';
import { createVault } from '../src/core/vault';
import {
	createTestAdapter,
	ingestSchema,
	makeImportFiles,
	testSchema,
	validIngestData,
} from './fixtures/testAdapter';

/**
 * Small helper to create an in-memory DB + vault instance (same pattern as vault.spec.ts)
 */
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

/**
 * Utility: transform the keys of a Map<string, File> by applying a replacer function
 */
function remapFileKeys(files: Map<string, File>, fn: (k: string) => string) {
	const out = new Map<string, File>();
	for (const [k, v] of files) {
		out.set(fn(k), v);
	}
	return out;
}

test('import path variants: default path (export shape) works', async () => {
	const { sqlite, db, vault } = createVaultInstance();
	try {
		const ingested = ingestSchema(validIngestData);
		if ('issues' in ingested) throw new Error('Ingested data has issues');
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

test('import path variants: empty base path (adapter/table/filename) works', async () => {
	const { sqlite, db, vault } = createVaultInstance();
	try {
		const ingested = ingestSchema(validIngestData);
		if ('issues' in ingested) throw new Error('Ingested data has issues');
		const files = makeImportFiles(ingested);
		const remapped = remapFileKeys(files, (k) => k.replace(/^vault\//, '')); // remove vault/
		await vault.importData({
			files: remapped,
			codec: jsonFormat,
		});
		const rows = await db.select().from(testSchema.test_items);
		assert.equal(rows.length, validIngestData.items.length);
	} finally {
		sqlite.close();
	}
});

test('import path variants: non-default base path (data/vault/...) works', async () => {
	const { sqlite, db, vault } = createVaultInstance();
	try {
		const ingested = ingestSchema(validIngestData);
		if ('issues' in ingested) throw new Error('Ingested data has issues');
		const files = makeImportFiles(ingested);
		const remapped = remapFileKeys(files, (k) => `data/${k}`); // prepend data/
		await vault.importData({
			files: remapped,
			codec: jsonFormat,
		});
		const rows = await db.select().from(testSchema.test_items);
		assert.equal(rows.length, validIngestData.items.length);
	} finally {
		sqlite.close();
	}
});

test('import path variants: multiple folders before vault works', async () => {
	const { sqlite, db, vault } = createVaultInstance();
	try {
		const ingested = ingestSchema(validIngestData);
		if ('issues' in ingested) throw new Error('Ingested data has issues');
		const files = makeImportFiles(ingested);
		const remapped = remapFileKeys(files, (k) => `a/b/${k}`);
		await vault.importData({
			files: remapped,
			codec: jsonFormat,
		});
		const rows = await db.select().from(testSchema.test_items);
		assert.equal(rows.length, validIngestData.items.length);
	} finally {
		sqlite.close();
	}
});

test('import path variants: duplicate/trailing slashes are tolerated', async () => {
	const { sqlite, db, vault } = createVaultInstance();
	try {
		const ingested = ingestSchema(validIngestData);
		if ('issues' in ingested) throw new Error('Ingested data has issues');
		const files = makeImportFiles(ingested);
		// Inject an extra slash in the base path and in the table segment
		const remapped = remapFileKeys(files, (k) =>
			k.replace('vault/', 'vault//').replace('test_items/', 'test_items//'),
		);
		await vault.importData({
			files: remapped,
			codec: jsonFormat,
		});
		const rows = await db.select().from(testSchema.test_items);
		assert.equal(rows.length, validIngestData.items.length);
	} finally {
		sqlite.close();
	}
});
