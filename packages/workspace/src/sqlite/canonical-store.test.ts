/** Canonical store tests for schema-opaque admission invariants. */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { RESERVED_KV_ROW_ID, RESERVED_KV_TABLE } from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { createCanonicalStore } from './canonical-store.js';
import { initializeLocalWorkspaceStorage } from './local-workspace-storage.js';

test('local and synchronized stores refuse nonportable intents before forwarding', () => {
	for (const synchronized of [false, true]) {
		const database = new Database(':memory:');
		const sqlite = createBunSqliteAdapter(database);
		initializeLocalWorkspaceStorage(sqlite);
		let forwarded = 0;
		const store = createCanonicalStore(sqlite, {
			...(synchronized
				? {
						admitIntent() {
							forwarded += 1;
						},
					}
				: {}),
		});
		try {
			expect(() =>
				store.admit({
					kind: 'update',
					table: 'notes',
					rowId: '../outside',
					fields: { set: { title: 'no' }, unset: [] },
				}),
			).toThrow('Invalid row intent');
			expect(() =>
				store.admit({
					kind: 'create',
					table: '__epicenter_private',
					rowId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
					fields: {},
				}),
			).toThrow('Invalid row intent');
			expect(() =>
				store.admit({
					kind: 'delete',
					table: RESERVED_KV_TABLE,
					rowId: RESERVED_KV_ROW_ID,
				}),
			).toThrow('Invalid row intent');
			expect(forwarded).toBe(0);
		} finally {
			database.close();
		}
	}
});

test('oversized KV updates are accepted local no-ops', () => {
	const database = new Database(':memory:');
	try {
		const sqlite = createBunSqliteAdapter(database);
		initializeLocalWorkspaceStorage(sqlite);
		const store = createCanonicalStore(sqlite);
		store.admit({
			kind: 'update',
			table: RESERVED_KV_TABLE,
			rowId: RESERVED_KV_ROW_ID,
			fields: { set: { label: 'small' }, unset: [] },
		});
		store.admit({
			kind: 'update',
			table: RESERVED_KV_TABLE,
			rowId: RESERVED_KV_ROW_ID,
			fields: { set: { label: 'x'.repeat(70 * 1024) }, unset: [] },
		});
		expect(store.read(RESERVED_KV_TABLE, RESERVED_KV_ROW_ID)).toEqual({
			label: 'small',
		});
	} finally {
		database.close();
	}
});
