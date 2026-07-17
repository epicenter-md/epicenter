/**
 * Canonical KV Tests
 *
 * Verifies the typed KV lens over the reserved immortal row in local-only and
 * synchronized ownership modes.
 *
 * Key behaviors:
 * - set, unset, and get round-trip through RowIntent projection
 * - unknown and nonconforming values survive typed writes
 * - an aggregate-cap overflow deterministically no-ops
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { RESERVED_KV_ROW_ID, RESERVED_KV_TABLE } from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/row-sync/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { mergeDocumentUpdates } from './canonical-documents.js';
import { createCanonicalKv } from './canonical-kv.js';
import {
	createCanonicalReplica,
	initializeCanonicalSchema,
} from './canonical-replica.js';
import {
	createTestTransport,
	openTestAuthority,
} from './row-sync-test-utils.js';

const definitions = {
	theme: field.select(['light', 'dark']),
	label: field.string(),
};

test('local-only set and unset preserve unknown and nonconforming keys', () => {
	const database = new Database(':memory:');
	try {
		const sqlite = createBunSqliteAdapter(database);
		initializeCanonicalSchema(sqlite);
		sqlite.run(
			`INSERT INTO rows(table_key, row_id, fields_json) VALUES (?, ?, ?)`,
			[
				RESERVED_KV_TABLE,
				RESERVED_KV_ROW_ID,
				JSON.stringify({ unknown: { nested: true }, theme: 'future' }),
			],
		);
		const kv = createCanonicalKv(sqlite, definitions);
		const nonconforming = expectErr(kv.get('theme'));
		expect(nonconforming.raw).toBe('future');
		expectOk(kv.set('label', 'kept'));
		expect(expectOk(kv.get('label'))).toBe('kept');
		kv.unset('label');
		expect(expectOk(kv.get('label'))).toBeUndefined();
		const stored = JSON.parse(
			database
				.query<{ fields_json: string }, []>(
					'SELECT fields_json FROM rows WHERE table_key = "__epicenter_kv"',
				)
				.get()?.fields_json ?? '{}',
		);
		expect(stored).toEqual({ unknown: { nested: true }, theme: 'future' });
		expect(database.query('SELECT * FROM replica').all()).toEqual([]);
		expect(database.query('SELECT * FROM intents').all()).toEqual([]);
	} finally {
		database.close();
	}
});

test('synchronized set and unset round-trip through the authority', async () => {
	const authorityState = openTestAuthority();
	const transport = createTestTransport(authorityState.authority);
	const database = new Database(':memory:');
	try {
		const sqlite = createBunSqliteAdapter(database);
		const replica = createCanonicalReplica({
			sqlite,
			transport,
			codec: { mergeUpdates: mergeDocumentUpdates },
		});
		const kv = createCanonicalKv(sqlite, definitions, {
			admitIntent: replica.admit,
		});
		expectOk(kv.set('theme', 'dark'));
		expect(expectOk(kv.get('theme'))).toBe('dark');
		await replica.synchronize();
		expect(authorityState.authority.inspect().rows[0]?.fields).toEqual({
			theme: 'dark',
		});
		kv.unset('theme');
		await replica.synchronize();
		expect(expectOk(kv.get('theme'))).toBeUndefined();
	} finally {
		database.close();
		authorityState.database.close();
	}
});

test('aggregate-cap overflow is an accepted local no-op', () => {
	const database = new Database(':memory:');
	try {
		const kv = createCanonicalKv(createBunSqliteAdapter(database), definitions);
		expectOk(kv.set('label', 'small'));
		expectOk(kv.set('label', 'x'.repeat(70 * 1024)));
		expect(expectOk(kv.get('label'))).toBe('small');
	} finally {
		database.close();
	}
});
