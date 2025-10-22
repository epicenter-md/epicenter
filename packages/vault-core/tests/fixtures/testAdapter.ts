import { type } from 'arktype';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { jsonFormat } from '../../src/codecs';
import { defineAdapter } from '../../src/core/adapter';
import type { MigrationMetadata } from '../../src/core/import/migrationMetadata';
import { defineIngestor } from '../../src/core/ingestor';
import {
	defineTransformRegistry,
	defineVersions,
} from '../../src/core/migrations';

function createMemoryFile(
	name: string,
	payload: unknown,
	type = 'application/json',
): File {
	const contents =
		typeof payload === 'string'
			? payload
			: jsonFormat.stringify(payload as Record<string, unknown>);
	return new File([new Blob([contents], { type })], name, { type });
}

const testItems = sqliteTable('test_items', {
	id: integer('id').primaryKey(),
	name: text('name').notNull(),
	createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const testSchema = {
	test_items: testItems,
};

export const testVersions = defineVersions({
	tag: '0000',
	sql: [
		`CREATE TABLE IF NOT EXISTS test_items (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);`,
	],
});

export const testTransforms = defineTransformRegistry({});

export const ingestSchema = type({
	items: type({
		id: 'number',
		name: 'string',
		createdAt: type('number').pipe((v) => new Date(v)),
	}).array(),
});

const jsonIngestor = defineIngestor({
	matches(file: File) {
		return file.name.endsWith('.json');
	},
	async parse(file) {
		const text = await file.text();
		return JSON.parse(text);
	},
});

export const TEST_ADAPTER_ID = 'test';

export const createTestAdapter = defineAdapter(() => ({
	id: TEST_ADAPTER_ID,
	schema: testSchema,
	versions: testVersions,
	transforms: testTransforms,
	validator: ingestSchema,
	ingestors: [jsonIngestor],
}));

export const validIngestData = {
	items: [
		{ id: 1, name: 'Alpha', createdAt: 1700000000000 },
		{ id: 2, name: 'Beta', createdAt: 1700000000500 },
	],
} satisfies typeof ingestSchema.inferIn; // This represents the expected input shape

export const invalidIngestData = {
	items: [{ id: 3 } as unknown as (typeof validIngestData)['items'][number]],
};

export function makeIngestFile(
	data = validIngestData,
	name = 'test-data.json',
): File {
	const ingestPayload = {
		items: data.items.map((item) => ({ ...item })),
	};
	return createMemoryFile(name, ingestPayload);
}

export function makeImportFiles(
	data: typeof ingestSchema.inferOut,
): Map<string, File> {
	const files = new Map<string, File>();
	const records = data.items;
	for (const item of records) {
		const filename = `${item.id}.json`;
		// Use the same path structure as export: vault/adapter/table/filename
		files.set(
			`vault/test/test_items/${filename}`,
			createMemoryFile(filename, item),
		);
	}
	files.set(
		`__meta__/${TEST_ADAPTER_ID}/migration.json`,
		createMemoryFile('migration.json', {
			tag: testVersions[testVersions.length - 1]?.tag ?? null,
			adapterId: TEST_ADAPTER_ID,
			source: 'adapter',
			ledgerTag: null,
			latestDeclaredTag: testVersions[testVersions.length - 1]?.tag ?? null,
			versions: testVersions.map((version) => version.tag),
			exportedAt: new Date(0),
		} satisfies MigrationMetadata),
	);
	return files;
}
