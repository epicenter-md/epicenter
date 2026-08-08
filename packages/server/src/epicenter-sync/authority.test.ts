/**
 * Epicenter Sync SQLite Authority Tests
 *
 * Verifies the authority's physical format, single-receipt discipline,
 * fixed-through paging, terminal deletion cleanup, and storage wall rollback.
 *
 * Key behaviors:
 * - Fresh stores initialize once and unknown formats are refused
 * - Exact retries reuse receipts while forks and gaps mutate nothing
 * - Pages retain one through boundary and row deletion removes documents
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { batchDigest, type Intent } from '@epicenter/data/legacy/protocol';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import {
	AUTHORITY_STORAGE_BYTE_CEILING,
	openEpicenterSyncAuthority,
} from './authority.js';

const REPLICA = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const NAMESPACE = 'so.epicenter.tests';
const ROW_ADDRESS = {
	namespace: NAMESPACE,
	tableName: 'rows',
	rowId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;
const VALUE_ADDRESS = {
	kind: 'value',
	namespace: NAMESPACE,
	valueName: 'value',
} as const;

function batch(seq: number, intents: Intent[]) {
	return { seq, digest: batchDigest(intents), intents };
}

function setup(options: { pageSize?: number; size?: () => number } = {}) {
	const raw = new Database(':memory:');
	const database = createBunSqliteAdapter(raw);
	const authority = openEpicenterSyncAuthority({
		database,
		pageSize: options.pageSize,
		readDatabaseSize: options.size,
	});
	return { raw, database, authority };
}

test('fresh schema reopens and an unknown format is refused without rewrite', () => {
	const { raw, database } = setup();
	expect(() => openEpicenterSyncAuthority({ database })).not.toThrow();
	raw.run(
		'UPDATE main._authority_metadata SET format_version = 99 WHERE singleton = 1',
	);
	expect(() => openEpicenterSyncAuthority({ database })).toThrow(
		'format 99 is not supported',
	);
	expect(
		raw
			.query<{ format_version: number }, []>(
				'SELECT format_version FROM main._authority_metadata',
			)
			.get()?.format_version,
	).toBe(99);
	raw.close();
});

