/**
 * Row-Body Runtime Tests (ADR-0133)
 *
 * Verifies the sequence-addressed body log: durable local edits, hydration
 * from accepted plus pending state, synchronized convergence through the
 * fold-never-refuse authority, permanent deletion, and local compaction.
 *
 * Key behaviors:
 * - an acknowledged edit survives any crash; parking is outbox ordering
 * - two replicas' concurrent edits merge and converge byte-identically
 * - deletion purges body state everywhere and late edits fold to no-ops
 * - the local log compacts into one baseline past its threshold
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { field } from '@epicenter/field';
import { openRecordAuthority } from '@epicenter/record-sync';
import { createBunSqliteAdapter } from '@epicenter/record-sync/bun';
import * as Y from 'yjs';
import { createCanonicalBodies } from './canonical-bodies.js';
import { createCanonicalRecords } from './canonical-records.js';
import {
	type CanonicalReplicaTransport,
	createCanonicalReplica,
} from './canonical-replica.js';
import { defineTable } from './lens-definition.js';

const definitions = {
	notes: defineTable({ fields: { title: field.string() } }),
};

async function sha256(value: string): Promise<string> {
	return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

function openSynced(path: string, authority: ReturnType<typeof openRecordAuthority>) {
	const native = new Database(path, { create: true });
	const sqlite = createBunSqliteAdapter(native);
	const transport: CanonicalReplicaTransport = {
		async sync(request) {
			return authority.sync(request);
		},
		async snapshotChunk(request) {
			return authority.snapshotChunk(request);
		},
	};
	const replica = createCanonicalReplica({ sqlite, transport, sha256 });
	const records = createCanonicalRecords(sqlite, definitions, {
		admit: replica.admit,
	});
	const bodies = createCanonicalBodies(sqlite, { admit: replica.admit });
	return { native, replica, records, bodies, notes: records.tables.notes };
}

function text(handle: { doc: Y.Doc }): string {
	return handle.doc.getText('body').toString();
}

test('offline edits acknowledge durably and survive a crash, then sync as one round', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-bodies-'));
	const path = join(root, 'replica.sqlite3');
	const authorityNative = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(authorityNative),
			sha256,
		});
		const first = openSynced(path, authority);
		const note = first.notes.create({ title: 'Plan' });
		{
			using opened = first.bodies.open('notes', note.id);
			opened.doc.getText('body').insert(0, 'Hello');
			opened.doc.getText('body').insert(5, ' world');
			await opened.whenDurable();
		}
		first.native.close();

		// Crash boundary: only the file survives. Both edits acknowledged, so
		// both hydrate; nothing reached the authority yet.
		expect(authority.inspect().head).toBe(0);
		const reopened = openSynced(path, authority);
		{
			using opened = reopened.bodies.open('notes', note.id);
			expect(text(opened)).toBe('Hello world');
		}

		// Create precedes appends in the same round: parking is ordering.
		await reopened.replica.synchronize();
		expect(authority.inspect().rows).toMatchObject([{ rowId: note.id }]);
		expect(authority.inspect().bodyLog.length).toBeGreaterThan(0);
		reopened.native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('two replicas converge on concurrent body edits', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-bodies-'));
	const authorityNative = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(authorityNative),
			sha256,
		});
		const a = openSynced(join(root, 'a.sqlite3'), authority);
		const b = openSynced(join(root, 'b.sqlite3'), authority);

		const note = a.notes.create({ title: 'Doc' });
		{
			using opened = a.bodies.open('notes', note.id);
			opened.doc.getText('body').insert(0, 'base ');
		}
		await a.replica.synchronize();
		await b.replica.synchronize();

		// Concurrent offline edits on both replicas.
		{
			using opened = a.bodies.open('notes', note.id);
			const body = opened.doc.getText('body');
			body.insert(body.length, 'from-A ');
		}
		{
			using opened = b.bodies.open('notes', note.id);
			const body = opened.doc.getText('body');
			body.insert(body.length, 'from-B ');
		}
		await a.replica.synchronize();
		await b.replica.synchronize();
		await a.replica.synchronize();

		using mergedA = a.bodies.open('notes', note.id);
		using mergedB = b.bodies.open('notes', note.id);
		expect(text(mergedA)).toContain('from-A');
		expect(text(mergedA)).toContain('from-B');
		expect(text(mergedA)).toBe(text(mergedB));
		a.native.close();
		b.native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('an open body sees accepted remote updates through refresh', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-bodies-'));
	const authorityNative = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(authorityNative),
			sha256,
		});
		const a = openSynced(join(root, 'a.sqlite3'), authority);
		const b = openSynced(join(root, 'b.sqlite3'), authority);
		const note = a.notes.create({ title: 'Doc' });
		{
			using opened = a.bodies.open('notes', note.id);
			opened.doc.getText('body').insert(0, 'first ');
		}
		await a.replica.synchronize();
		await b.replica.synchronize();

		using watching = b.bodies.open('notes', note.id);
		expect(text(watching)).toBe('first ');

		{
			using opened = a.bodies.open('notes', note.id);
			const body = opened.doc.getText('body');
			body.insert(body.length, 'second');
		}
		await a.replica.synchronize();
		await b.replica.synchronize();
		watching.refresh();
		expect(text(watching)).toBe('first second');
		a.native.close();
		b.native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('deleting the row purges body state everywhere; a late edit folds away', async () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-bodies-'));
	const authorityNative = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(authorityNative),
			sha256,
		});
		const a = openSynced(join(root, 'a.sqlite3'), authority);
		const b = openSynced(join(root, 'b.sqlite3'), authority);
		const note = a.notes.create({ title: 'Doomed' });
		{
			using opened = a.bodies.open('notes', note.id);
			opened.doc.getText('body').insert(0, 'content');
		}
		await a.replica.synchronize();
		await b.replica.synchronize();

		// B deletes: local log purges with the row, authority purges its log.
		b.notes.delete(note.id);
		b.bodies.purgeRow('notes', note.id);
		await b.replica.synchronize();
		expect(authority.inspect().bodyLog).toEqual([]);

		// A edits late, offline; the append is accepted and folds to nothing.
		{
			using opened = a.bodies.open('notes', note.id);
			opened.doc.getText('body').insert(0, 'late ');
		}
		await a.replica.synchronize();
		expect(authority.inspect().bodyLog).toEqual([]);
		expect(authority.inspect().rows).toEqual([]);
		a.native.close();
		b.native.close();
	} finally {
		authorityNative.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('the local log compacts into one baseline past the threshold', () => {
	const root = mkdtempSync(join(tmpdir(), 'canonical-bodies-'));
	try {
		const native = new Database(join(root, 'local.sqlite3'), { create: true });
		const sqlite = createBunSqliteAdapter(native);
		createCanonicalRecords(sqlite, definitions, {});
		// Standalone owner: no admit hook; edits stay device-local.
		const bodies = createCanonicalBodies(sqlite, {});
		{
			using opened = bodies.open('notes', 'local-note');
			for (let index = 0; index < 70; index += 1) {
				opened.doc.getText('body').insert(0, `${index} `);
			}
		}
		const before = native
			.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM __epicenter_bodies_log',
			)
			.get()?.count;
		expect(before).toBeGreaterThan(64);

		// Reopening compacts, and the content is byte-identical.
		using reopened = bodies.open('notes', 'local-note');
		const after = native
			.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM __epicenter_bodies_log',
			)
			.get()?.count;
		expect(after).toBe(1);
		expect(text(reopened).startsWith('69 68 67')).toBeTrue();
		native.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
