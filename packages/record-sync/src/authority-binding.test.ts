/**
 * Current-State Record Authority Tests
 *
 * Verifies persistent actor ordering and compactable current state in the
 * production SQLite authority.
 *
 * Key behaviors:
 * - exact latest retries return the original receipt
 * - server order resolves patches while preserving unknown JSON keys
 * - create conflicts roll back whole pushes
 * - tombstone compaction forces a current-state snapshot
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createBunSqliteAdapter } from './adapters/bun.js';
import { encodedJsonBytes, RECORD_SYNC_ADMISSION_LIMITS } from './admission.js';
import { openRecordAuthority } from './authority.js';
import type { JsonObject, PushRequest, RecordCommand } from './protocol.js';
import { RECORD_SYNC_PROTOCOL_MAJOR } from './protocol.js';

const sha256 = async (value: string) =>
	createHash('sha256').update(value).digest('hex');

function push(
	actorId: string,
	commands: RecordCommand[],
	firstActorSequence = 1,
): PushRequest {
	return {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'push',
		actorId,
		mutations: commands.map((command, index) => ({
			actorSequence: firstActorSequence + index,
			command,
		})),
	};
}

function create(
	rowId: string,
	value: JsonObject = { title: 'Initial' },
): RecordCommand {
	return { kind: 'createRow', table: 'skills', rowId, value };
}

function patch(
	rowId: string,
	set: Record<string, string | number | boolean | null | { source: string }>,
	unset: string[] = [],
): RecordCommand {
	return { kind: 'patchRow', table: 'skills', rowId, set, unset };
}

function remove(rowId: string): RecordCommand {
	return { kind: 'deleteRow', table: 'skills', rowId };
}

test('snapshot publication is absent below the compaction threshold', async () => {
	const sqlite = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(sqlite),
			sha256,
		});
		expect(
			await authority.maybePublishSnapshot({
				minimumRetainedSequences: 0,
				maxChunkBytes: 512 * 1024,
			}),
		).toBeUndefined();
	} finally {
		sqlite.close();
	}
});

test('exact latest retry returns its receipt without advancing state', () => {
	const sqlite = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(sqlite),
			sha256,
		});
		const batch = push('actor-a', [
			create('skill-1'),
			patch('skill-1', { title: 'Updated' }),
		]);
		const accepted = authority.push(batch);
		const afterAccepted = authority.inspect();

		expect(accepted).toMatchObject({
			ok: true,
			acceptance: 'accepted',
		});
		expect(authority.push(structuredClone(batch))).toEqual({
			...(accepted as Extract<typeof accepted, { ok: true }>),
			acceptance: 'retry',
		});
		expect(authority.inspect()).toEqual(afterAccepted);
		expect(
			authority.push(push('actor-a', [patch('skill-1', { title: 'Fork' })])),
		).toEqual({ kind: 'push', ok: false, reason: 'actor-fork' });
		expect(
			authority.push(push('actor-a', [patch('skill-1', { title: 'Gap' })], 4)),
		).toEqual({ kind: 'push', ok: false, reason: 'actor-sequence-gap' });
	} finally {
		sqlite.close();
	}
});

test('server acceptance order preserves unknown keys across mixed releases', () => {
	const sqlite = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(sqlite),
			sha256,
		});
		authority.push(
			push('old-release', [
				create('skill-1', {
					title: 'Old',
					futureMetadata: { source: 'import' },
				}),
			]),
		);
		authority.push(
			push('new-release', [
				patch('skill-1', { title: 'New', category: 'general' }),
			]),
		);
		authority.push(
			push('accepted-last', [patch('skill-1', { title: 'Last' })]),
		);

		expect(authority.inspect().rows).toEqual([
			{
				table: 'skills',
				rowId: 'skill-1',
				value: {
					title: 'Last',
					futureMetadata: { source: 'import' },
					category: 'general',
				},
				lastServerSequence: 3,
			},
		]);
	} finally {
		sqlite.close();
	}
});

test('authority patches preserve __proto__ as an ordinary own JSON key', () => {
	const sqlite = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(sqlite),
			sha256,
		});
		const original = JSON.parse(
			'{"title":"Safe","__proto__":{"source":"create"}}',
		) as JsonObject;
		const set = JSON.parse('{"__proto__":{"source":"patch"}}') as JsonObject;

		expect(
			authority.push(
				push('actor-a', [
					create('skill-1', original),
					{
						kind: 'patchRow',
						table: 'skills',
						rowId: 'skill-1',
						set,
						unset: [],
					},
				]),
			),
		).toMatchObject({ ok: true });
		const value = authority.inspect().rows[0]?.value;

		expect(value).toBeDefined();
		expect(Object.hasOwn(value as object, '__proto__')).toBeTrue();
		expect(Object.getOwnPropertyDescriptor(value, '__proto__')?.value).toEqual({
			source: 'patch',
		});
		expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
		expect(Object.getPrototypeOf({})).not.toHaveProperty('source');
	} finally {
		sqlite.close();
	}
});

test('create conflict rolls back the complete push and leaves sequence unconsumed', () => {
	const sqlite = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(sqlite),
			sha256,
		});
		authority.push(push('actor-a', [create('skill-1')]));
		const before = authority.inspect();

		expect(
			authority.push(push('actor-b', [create('skill-2'), create('skill-1')])),
		).toEqual({ kind: 'push', ok: false, reason: 'create-conflict' });
		expect(authority.inspect()).toEqual(before);
		expect(authority.push(push('actor-b', [create('skill-2')]))).toMatchObject({
			ok: true,
			acceptance: 'accepted',
		});
	} finally {
		sqlite.close();
	}
});

test('absent commands do not resurrect rows and still consume actor order', () => {
	const sqlite = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(sqlite),
			sha256,
		});
		authority.push(
			push('actor-a', [
				patch('missing', { title: 'No row' }),
				remove('missing'),
				create('skill-1'),
				remove('skill-1'),
				patch('skill-1', { title: 'Cannot resurrect' }),
			]),
		);

		expect(authority.inspect()).toMatchObject({
			head: 5,
			rows: [],
			deletions: [
				{
					table: 'skills',
					rowId: 'skill-1',
					lastServerSequence: 4,
				},
			],
			actorHighWater: { 'actor-a': 5 },
		});
	} finally {
		sqlite.close();
	}
});

test('create after delete starts a new row lifetime before or after compaction', async () => {
	for (const compact of [false, true]) {
		const sqlite = new Database(':memory:');
		try {
			const authority = openRecordAuthority({
				database: createBunSqliteAdapter(sqlite),
				sha256,
			});
			authority.push(push('actor-a', [create('skill-1'), remove('skill-1')]));
			if (compact) {
				const manifest = await authority.publishSnapshot({
					maxChunkBytes: 512 * 1024,
				});
				if (!manifest) throw new Error('Expected snapshot publication');
				authority.compactDeletionsThrough(manifest.head);
			}
			expect(
				authority.push(
					push('actor-b', [create('skill-1', { title: 'New lifetime' })]),
				),
			).toMatchObject({ ok: true, acceptance: 'accepted' });
			expect(authority.inspect().rows).toMatchObject([
				{ rowId: 'skill-1', value: { title: 'New lifetime' } },
			]);
		} finally {
			sqlite.close();
		}
	}
});

test('pull paginates before the encoded response byte ceiling', () => {
	const sqlite = new Database(':memory:');
	try {
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(sqlite),
			sha256,
		});
		const body = 'x'.repeat(240 * 1024);
		for (let index = 0; index < 40; index += 1) {
			expect(
				authority.push(
					push(`actor-${index}`, [create(`skill-${index}`, { title: body })]),
				),
			).toMatchObject({ ok: true });
		}

		const first = authority.pull({
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			kind: 'pull',
			cursor: 0,
			limit: RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPull,
		});
		expect(first.ok).toBeTrue();
		if (!first.ok || first.snapshotRequired) {
			throw new Error('Expected an incremental pull page');
		}
		expect(first.hasMore).toBeTrue();
		expect(first.entries.length).toBeLessThan(40);
		expect(encodedJsonBytes(first)).toBeLessThanOrEqual(
			RECORD_SYNC_ADMISSION_LIMITS.encodedPullBytes,
		);

		const second = authority.pull({
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			kind: 'pull',
			cursor: first.newCursor,
			limit: RECORD_SYNC_ADMISSION_LIMITS.stateEntriesPerPull,
		});
		expect(second.ok).toBeTrue();
		if (!second.ok || second.snapshotRequired) {
			throw new Error('Expected the remaining incremental pull page');
		}
		expect(second.hasMore).toBeFalse();
		expect(first.entries.length + second.entries.length).toBe(40);
	} finally {
		sqlite.close();
	}
});

test('published snapshot covers compacted deletion markers across reopen', async () => {
	const sqlite = new Database(':memory:');
	try {
		const adapter = createBunSqliteAdapter(sqlite);
		const authority = openRecordAuthority({ database: adapter, sha256 });
		authority.push(push('actor-a', [create('skill-1'), remove('skill-1')]));
		const manifest = await authority.publishSnapshot({
			maxChunkBytes: 512 * 1024,
		});
		if (!manifest) throw new Error('Expected snapshot publication');
		expect(authority.compactDeletionsThrough(2)).toBe(2);

		const reopened = openRecordAuthority({ database: adapter, sha256 });
		expect(
			reopened.pull({
				protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
				kind: 'pull',
				cursor: 0,
				limit: 100,
			}),
		).toEqual({
			kind: 'pull',
			ok: true,
			snapshotRequired: true,
			manifest,
		});
		const chunk = reopened.snapshotChunk({
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			kind: 'snapshotChunk',
			generation: manifest.generation,
			index: 0,
		});
		expect(chunk).toMatchObject({ ok: true, chunk: { rows: [] } });
	} finally {
		sqlite.close();
	}
});

test('authority stores no schema, database selection, KV, or mutation log tables', () => {
	const sqlite = new Database(':memory:');
	try {
		openRecordAuthority({
			database: createBunSqliteAdapter(sqlite),
			sha256,
		});
		const names = sqlite
			.query<{ name: string }, []>(
				`SELECT name FROM sqlite_schema
				 WHERE type = 'table' AND name LIKE 'record_sync_%'
				 ORDER BY name`,
			)
			.all()
			.map(({ name }) => name);

		expect(names).toEqual([
			'record_sync_actors',
			'record_sync_deletions',
			'record_sync_meta',
			'record_sync_rows',
			'record_sync_snapshot_chunks',
			'record_sync_snapshot_manifest',
		]);
	} finally {
		sqlite.close();
	}
});

test('open refuses legacy authority storage instead of creating empty parallel state', () => {
	const sqlite = new Database(':memory:');
	try {
		sqlite.run(`
			CREATE TABLE record_sync_family (
				id INTEGER PRIMARY KEY,
				current_database_id TEXT NOT NULL
			)
		`);
		expect(() =>
			openRecordAuthority({
				database: createBunSqliteAdapter(sqlite),
				sha256,
			}),
		).toThrow('Incompatible legacy record-sync authority storage');
		expect(
			sqlite
				.query<{ count: number }, []>(
					`SELECT COUNT(*) AS count FROM sqlite_schema
					 WHERE type = 'table' AND name = 'record_sync_meta'`,
				)
				.get()?.count,
		).toBe(0);
	} finally {
		sqlite.close();
	}
});
