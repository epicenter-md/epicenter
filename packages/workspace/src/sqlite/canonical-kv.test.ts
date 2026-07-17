/**
 * Canonical KV Lens Tests (ADR-0130/0132)
 *
 * Verifies the typed lens over the reserved immortal record: honest reads,
 * validated writes, per-key observation, unknown-value preservation, and the
 * synchronized round trip through the fold-never-refuse authority.
 *
 * Key behaviors:
 * - absent reads undefined; invalid reads return the raw value, never heal
 * - a typed set validates before durable local admission
 * - unset returns a key to absence with no tombstone
 * - unknown and nonconforming keys survive typed writes and synchronization
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import {
	openRecordAuthority,
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
} from '@epicenter/record-sync';
import { createBunSqliteAdapter } from '@epicenter/record-sync/bun';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createCanonicalKv } from './canonical-kv.js';
import { createCanonicalRecords } from './canonical-records.js';
import {
	type CanonicalReplicaTransport,
	createCanonicalReplica,
} from './canonical-replica.js';
import { defineTable } from './lens-definition.js';
import { defineWorkspace } from './runtime-definition.js';

const kvDefinitions = {
	'editor.spellcheck': field.boolean(),
	'editor.defaultView': field.select(['reading', 'editing']),
	'shortcut.newNote': field.json(
		Type.Object({
			modifiers: Type.Array(Type.String()),
			keys: Type.Array(Type.String()),
		}),
	),
};

async function sha256(value: string): Promise<string> {
	return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

function setup(admit?: (command: never) => void) {
	const native = new Database(':memory:');
	const sqlite = createBunSqliteAdapter(native);
	// The records owner creates the canonical table the KV lens reads.
	createCanonicalRecords(sqlite, {}, admit ? { admit: admit as never } : {});
	const kv = createCanonicalKv(sqlite, kvDefinitions, {
		...(admit ? { admit: admit as never } : {}),
	});
	return { native, sqlite, kv };
}

function rawMap(native: Database): Record<string, unknown> {
	const stored = native
		.query<{ payload: string }, [string, string]>(
			`SELECT payload FROM __epicenter_records WHERE table_key = ? AND row_id = ?`,
		)
		.get(RESERVED_KV_TABLE, RESERVED_KV_ROW_ID);
	return stored ? JSON.parse(stored.payload) : {};
}

function seedRaw(native: Database, map: Record<string, unknown>): void {
	native.run(
		`INSERT INTO __epicenter_records(table_key, row_id, payload)
		 VALUES (?, ?, ?)
		 ON CONFLICT(table_key, row_id) DO UPDATE SET payload = excluded.payload`,
		[RESERVED_KV_TABLE, RESERVED_KV_ROW_ID, JSON.stringify(map)],
	);
}

test('absent reads undefined and never materializes a default', () => {
	const { native, kv } = setup();
	expect(expectOk(kv.get('editor.spellcheck'))).toBeUndefined();
	expect(rawMap(native)).toEqual({});
	native.close();
});

test('set validates, persists, and reads back; nested values replace atomically', () => {
	const { native, kv } = setup();
	expectOk(kv.set('editor.spellcheck', true));
	expectOk(kv.set('shortcut.newNote', { modifiers: ['meta'], keys: ['n'] }));
	expect(expectOk(kv.get('editor.spellcheck'))).toBeTrue();
	expect(expectOk(kv.get('shortcut.newNote'))).toEqual({
		modifiers: ['meta'],
		keys: ['n'],
	});

	// A nested value replaces whole, never merges.
	expectOk(kv.set('shortcut.newNote', { modifiers: ['ctrl'], keys: ['m'] }));
	expect(expectOk(kv.get('shortcut.newNote'))).toEqual({
		modifiers: ['ctrl'],
		keys: ['m'],
	});

	// An invalid typed set never enters canonical storage.
	const refused = expectErr(kv.set('editor.defaultView', 'split' as never));
	expect(refused.key).toBe('editor.defaultView');
	expect(rawMap(native)['editor.defaultView']).toBeUndefined();
	native.close();
});

test('unset returns a key to absence without a tombstone or stored default', () => {
	const { native, kv } = setup();
	expectOk(kv.set('editor.spellcheck', true));
	kv.unset('editor.spellcheck');
	expect(expectOk(kv.get('editor.spellcheck'))).toBeUndefined();
	expect(rawMap(native)).toEqual({});
	native.close();
});

test('invalid stored values read as errors carrying the raw value, never healed', () => {
	const { native, kv } = setup();
	seedRaw(native, {
		'editor.spellcheck': 'yes-please',
		'future.unknownKey': { nested: [1, 2] },
	});

	const reading = kv.get('editor.spellcheck');
	if (reading.error === null) throw new Error('Expected a nonconforming read');
	expect(reading.error.key).toBe('editor.spellcheck');
	expect(reading.error.raw).toBe('yes-please');

	// Reading did not heal, unset, or rewrite anything.
	expect(rawMap(native)).toEqual({
		'editor.spellcheck': 'yes-please',
		'future.unknownKey': { nested: [1, 2] },
	});
	native.close();
});

test('unknown and nonconforming keys survive typed writes', () => {
	const { native, kv } = setup();
	seedRaw(native, {
		'editor.spellcheck': 'yes-please',
		'future.unknownKey': { nested: [1, 2] },
	});
	expectOk(kv.set('editor.defaultView', 'reading'));
	expect(rawMap(native)).toEqual({
		'editor.spellcheck': 'yes-please',
		'future.unknownKey': { nested: [1, 2] },
		'editor.defaultView': 'reading',
	});
	native.close();
});

test('undeclared keys are unreachable through the lens', () => {
	const { native, kv } = setup();
	expect(() => kv.get('future.unknownKey' as never)).toThrow(
		"Unknown kv key 'future.unknownKey'",
	);
	expect(() => kv.set('future.unknownKey' as never, true as never)).toThrow(
		"Unknown kv key 'future.unknownKey'",
	);
	native.close();
});

test('observers fire per key on local writes and external installs', () => {
	const { native, kv } = setup();
	let spellcheckFired = 0;
	let viewFired = 0;
	const stopSpellcheck = kv.observe('editor.spellcheck', () => {
		spellcheckFired += 1;
	});
	kv.observe('editor.defaultView', () => {
		viewFired += 1;
	});

	expectOk(kv.set('editor.spellcheck', true));
	expect(spellcheckFired).toBe(1);
	expect(viewFired).toBe(0);

	// A remote install lands directly in canonical storage; the runtime then
	// pokes the lens, which fires only observers whose keys changed.
	seedRaw(native, { 'editor.spellcheck': true, 'editor.defaultView': 'editing' });
	kv.notifyExternalChange();
	expect(spellcheckFired).toBe(1);
	expect(viewFired).toBe(1);

	stopSpellcheck();
	expectOk(kv.set('editor.spellcheck', false));
	expect(spellcheckFired).toBe(1);
	native.close();
});

test('kv writes ride the replica round trip and converge through the authority', async () => {
	const authorityNative = new Database(':memory:');
	const writerNative = new Database(':memory:');
	const readerNative = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(authorityNative),
			sha256,
		});
		const transport: CanonicalReplicaTransport = {
			async sync(request) {
				return authority.sync(request);
			},
			async snapshotChunk(request) {
				return authority.snapshotChunk(request);
			},
		};

		const writerSqlite = createBunSqliteAdapter(writerNative);
		const writerReplica = createCanonicalReplica({
			sqlite: writerSqlite,
			transport,
			sha256,
		});
		createCanonicalRecords(writerSqlite, {}, { admit: writerReplica.admit });
		const writerKv = createCanonicalKv(writerSqlite, kvDefinitions, {
			admit: writerReplica.admit,
		});
		expectOk(writerKv.set('editor.spellcheck', true));
		expectOk(writerKv.set('editor.defaultView', 'editing'));
		writerKv.unset('editor.spellcheck');
		await writerReplica.synchronize();

		const readerSqlite = createBunSqliteAdapter(readerNative);
		const readerReplica = createCanonicalReplica({
			sqlite: readerSqlite,
			transport,
			sha256,
		});
		createCanonicalRecords(readerSqlite, {}, { admit: readerReplica.admit });
		const readerKv = createCanonicalKv(readerSqlite, kvDefinitions, {
			admit: readerReplica.admit,
		});
		await readerReplica.synchronize();
		expect(expectOk(readerKv.get('editor.defaultView'))).toBe('editing');
		expect(expectOk(readerKv.get('editor.spellcheck'))).toBeUndefined();
	} finally {
		authorityNative.close();
		writerNative.close();
		readerNative.close();
	}
});

test('defineWorkspace accepts direct kv schemas and refuses non-field values', () => {
	const workspace = defineWorkspace({
		id: 'epicenter-kv-test',
		tables: { notes: defineTable({ fields: { title: field.string() } }) },
		kv: kvDefinitions,
	});
	expect(Object.keys(workspace.kv)).toEqual(Object.keys(kvDefinitions));

	expect(() =>
		defineWorkspace({
			id: 'epicenter-kv-test',
			tables: {},
			kv: { broken: { not: 'a schema' } as never },
		}),
	).toThrow("KV key 'broken' must use the field.* vocabulary");
	expect(() =>
		defineWorkspace({
			id: 'epicenter-kv-test',
			tables: {},
			kv: { __epicenter_reserved: field.boolean() },
		}),
	).toThrow('Invalid KV key');
});
