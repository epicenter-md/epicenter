/**
 * Fold-Never-Refuse Record Authority Tests (ADR-0131/0132/0133)
 *
 * Verifies sealed-round folding and compactable current state in the
 * production SQLite authority.
 *
 * Key behaviors:
 * - a round folds exactly once; an exact retry regenerates pages, never state
 * - digest mismatch on the accepted round and stale rounds are terminal forks
 * - capacity and duplicate-create conflicts fold to deterministic no-ops
 * - the reserved KV record folds from `{}` and owns the aggregate cap
 * - body appends require a live row; deletion purges the body log forever
 * - tombstone compaction forces a current-state snapshot
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createBunSqliteAdapter } from './adapters/bun.js';
import {
	encodedJsonBytes,
	RECORD_SYNC_ADMISSION_LIMITS,
	RESERVED_KV_ROW_ID,
	RESERVED_KV_TABLE,
} from './admission.js';
import { openRecordAuthority, type RecordAuthority } from './authority.js';
import type {
	JsonObject,
	RecordCommand,
	SyncRequest,
	SyncResponse,
	SyncToken,
} from './protocol.js';
import { RECORD_SYNC_PROTOCOL_MAJOR } from './protocol.js';
import { recordRoundDigest } from './round-digest.js';

const sha256 = async (value: string) =>
	createHash('sha256').update(value).digest('hex');

function token(
	replicaId: string,
	acceptedRound = 0,
	checkpoint = 0,
): SyncToken {
	return { replicaId, acceptedRound, checkpoint };
}

function syncRound(
	tokenValue: SyncToken,
	commands: RecordCommand[],
	overrides: Partial<SyncRequest['sealedRound'] & object> = {},
): SyncRequest {
	return {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'sync',
		token: tokenValue,
		sealedRound: {
			round: tokenValue.acceptedRound + 1,
			requestDigest: recordRoundDigest(commands),
			commands,
			...overrides,
		},
	};
}

function syncPull(tokenValue: SyncToken, pageLimit?: number): SyncRequest {
	return {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		kind: 'sync',
		token: tokenValue,
		...(pageLimit === undefined ? {} : { pageLimit }),
	};
}

function expectPage(
	response: SyncResponse,
): Extract<SyncResponse, { ok: true; snapshotRequired: false }> {
	if (!response.ok || response.snapshotRequired) {
		throw new Error(`Expected an incremental page: ${JSON.stringify(response)}`);
	}
	return response;
}

function create(
	rowId: string,
	value: JsonObject = { title: 'Initial' },
): RecordCommand {
	return { kind: 'createRow', table: 'skills', rowId, value };
}

function patch(
	rowId: string,
	set: JsonObject,
	unset: string[] = [],
): RecordCommand {
	return { kind: 'patchRow', table: 'skills', rowId, set, unset };
}

function remove(rowId: string): RecordCommand {
	return { kind: 'deleteRow', table: 'skills', rowId };
}

function bodyAppend(rowId: string, update: string): RecordCommand {
	return { kind: 'bodyAppend', table: 'skills', rowId, update };
}

function kvPatch(set: JsonObject, unset: string[] = []): RecordCommand {
	return {
		kind: 'patchRow',
		table: RESERVED_KV_TABLE,
		rowId: RESERVED_KV_ROW_ID,
		set,
		unset,
	};
}

function withAuthority(
	run: (authority: RecordAuthority, sqlite: Database) => void | Promise<void>,
): void | Promise<void> {
	const sqlite = new Database(':memory:');
	const finish = () => sqlite.close();
	try {
		const result = run(
			openRecordAuthority({ database: createBunSqliteAdapter(sqlite), sha256 }),
			sqlite,
		);
		if (result instanceof Promise) return result.finally(finish);
		finish();
	} catch (error) {
		finish();
		throw error;
	}
}

test('snapshot publication is absent below the compaction threshold', async () => {
	await withAuthority(async (authority) => {
		expect(
			await authority.maybePublishSnapshot({
				minimumRetainedSequences: 0,
				maxChunkBytes: 512 * 1024,
			}),
		).toBeUndefined();
	});
});

test('a round folds exactly once and an exact retry regenerates pages', () => {
	withAuthority((authority) => {
		const replica = token('replica-a');
		const request = syncRound(replica, [
			create('skill-1'),
			patch('skill-1', { title: 'Updated' }),
		]);
		const accepted = expectPage(authority.sync(request));
		expect(accepted.token).toEqual({
			replicaId: 'replica-a',
			acceptedRound: 1,
			checkpoint: 2,
		});
		const afterAccepted = authority.inspect();

		const retried = expectPage(authority.sync(structuredClone(request)));
		expect(retried.entries).toEqual(accepted.entries);
		expect(authority.inspect()).toEqual(afterAccepted);
	});
});

test('digest mismatch on the accepted round is the terminal fork verdict', () => {
	withAuthority((authority) => {
		const replica = token('replica-a');
		authority.sync(syncRound(replica, [create('skill-1')]));
		const divergent = [create('skill-2')];

		expect(
			authority.sync(
				syncRound(replica, divergent, {
					round: 1,
					requestDigest: recordRoundDigest(divergent),
				}),
			),
		).toEqual({ kind: 'sync', ok: false, reason: 'replica-fork' });
		expect(authority.inspect().rows).toHaveLength(1);
	});
});

test('a stale or skipped round number is terminal, never silently absorbed', () => {
	withAuthority((authority) => {
		const replica = token('replica-a');
		authority.sync(syncRound(replica, [create('skill-1')]));
		authority.sync(
			syncRound(token('replica-a', 1, 1), [patch('skill-1', { n: 2 })]),
		);

		// A late clone still submitting round 1 with different content.
		const stale = [remove('skill-1')];
		expect(
			authority.sync(
				syncRound(replica, stale, {
					round: 1,
					requestDigest: recordRoundDigest(stale),
				}),
			),
		).toEqual({ kind: 'sync', ok: false, reason: 'replica-fork' });
		// A skipped-future round proves the same corruption.
		expect(
			authority.sync(
				syncRound(token('replica-a', 3, 0), [create('skill-9')]),
			),
		).toEqual({ kind: 'sync', ok: false, reason: 'replica-fork' });
		expect(authority.inspect().rows).toMatchObject([
			{ rowId: 'skill-1', value: { title: 'Initial', n: 2 } },
		]);
	});
});

test('server acceptance order preserves unknown keys across mixed releases', () => {
	withAuthority((authority) => {
		authority.sync(
			syncRound(token('old-release'), [
				create('skill-1', {
					title: 'Old',
					futureMetadata: { source: 'import' },
				}),
			]),
		);
		authority.sync(
			syncRound(token('new-release'), [
				patch('skill-1', { title: 'New', category: 'general' }),
			]),
		);
		authority.sync(
			syncRound(token('accepted-last'), [patch('skill-1', { title: 'Last' })]),
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
	});
});

test('authority patches preserve __proto__ as an ordinary own JSON key', () => {
	withAuthority((authority) => {
		const original = JSON.parse(
			'{"title":"Safe","__proto__":{"source":"create"}}',
		) as JsonObject;
		const set = JSON.parse('{"__proto__":{"source":"patch"}}') as JsonObject;

		expect(
			expectPage(
				authority.sync(
					syncRound(token('replica-a'), [
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
			).hasMore,
		).toBeFalse();
		const value = authority.inspect().rows[0]?.value;

		expect(value).toBeDefined();
		expect(Object.hasOwn(value as object, '__proto__')).toBeTrue();
		expect(Object.getOwnPropertyDescriptor(value, '__proto__')?.value).toEqual({
			source: 'patch',
		});
		expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
		expect(Object.getPrototypeOf({})).not.toHaveProperty('source');
	});
});

test('a duplicate create folds to a no-op and the rest of the round applies', () => {
	withAuthority((authority) => {
		authority.sync(syncRound(token('replica-a'), [create('skill-1')]));

		const response = expectPage(
			authority.sync(
				syncRound(token('replica-b'), [
					create('skill-1', { title: 'Loser' }),
					create('skill-2'),
				]),
			),
		);
		expect(response.token.acceptedRound).toBe(1);
		expect(authority.inspect().rows).toMatchObject([
			{ rowId: 'skill-1', value: { title: 'Initial' } },
			{ rowId: 'skill-2', value: { title: 'Initial' } },
		]);
	});
});

test('absent commands do not resurrect rows and still consume server order', () => {
	withAuthority((authority) => {
		authority.sync(
			syncRound(token('replica-a'), [
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
			replicaRounds: { 'replica-a': 1 },
		});
	});
});

test('a composed row over the capacity cap folds to a no-op, not a refusal', () => {
	withAuthority((authority) => {
		const half = 'x'.repeat(260 * 1024);
		authority.sync(syncRound(token('replica-a'), [create('skill-1', {})]));
		authority.sync(
			syncRound(token('replica-a', 1, 0), [patch('skill-1', { a: half })]),
		);

		// Fits alone, over the cap composed: accepted, ordered, no-op.
		const response = expectPage(
			authority.sync(syncRound(token('replica-b'), [patch('skill-1', { b: half })])),
		);
		expect(response.token.acceptedRound).toBe(1);
		const inspected = authority.inspect();
		expect(inspected.head).toBe(3);
		expect(Object.keys(inspected.rows[0]?.value ?? {})).toEqual(['a']);
	});
});

test('the reserved KV record folds from {} and owns the aggregate cap', () => {
	withAuthority((authority) => {
		// First write materializes the map through the patch-on-absent fold.
		authority.sync(
			syncRound(token('replica-a'), [kvPatch({ 'editor.spellcheck': true })]),
		);
		// Different keys compose; unset removes without a tombstone.
		authority.sync(
			syncRound(token('replica-b'), [
				kvPatch({ theme: 'dark' }, ['editor.spellcheck']),
			]),
		);
		expect(authority.inspect().rows).toMatchObject([
			{
				table: RESERVED_KV_TABLE,
				rowId: RESERVED_KV_ROW_ID,
				value: { theme: 'dark' },
			},
		]);

		// The 64 KiB aggregate cap folds the overflowing write to a no-op.
		const nearCap = 'x'.repeat(63 * 1024);
		authority.sync(
			syncRound(token('replica-a', 1, 0), [kvPatch({ big: nearCap })]),
		);
		const overflowing = expectPage(
			authority.sync(
				syncRound(token('replica-b', 1, 0), [kvPatch({ more: 'y'.repeat(2 * 1024) })]),
			),
		);
		expect(overflowing.token.acceptedRound).toBe(2);
		const map = authority.inspect().rows[0]?.value ?? {};
		expect(map.big).toBe(nearCap);
		expect(map.more).toBeUndefined();
	});
});

test('body appends require a live row and deletion purges the log forever', () => {
	withAuthority((authority) => {
		authority.sync(
			syncRound(token('replica-a'), [
				create('note-1'),
				bodyAppend('note-1', 'dXBkYXRlLTE='),
				bodyAppend('note-1', 'dXBkYXRlLTI='),
			]),
		);
		expect(authority.inspect().bodyLog).toMatchObject([
			{ rowId: 'note-1', lastServerSequence: 2 },
			{ rowId: 'note-1', lastServerSequence: 3 },
		]);
		const page = expectPage(authority.sync(syncPull(token('reader'))));
		expect(page.entries.map((entry) => entry.kind)).toEqual([
			'row',
			'bodyUpdate',
			'bodyUpdate',
		]);

		// Deletion purges; a late append is accepted and folds to a no-op.
		authority.sync(syncRound(token('replica-b'), [remove('note-1')]));
		expect(authority.inspect().bodyLog).toEqual([]);
		const late = expectPage(
			authority.sync(
				syncRound(token('replica-c'), [bodyAppend('note-1', 'c3RhbGU=')]),
			),
		);
		expect(late.token.acceptedRound).toBe(1);
		expect(authority.inspect().bodyLog).toEqual([]);
		expect(authority.inspect().rows).toEqual([]);
	});
});

test('sync paginates before the encoded response byte ceiling', () => {
	withAuthority((authority) => {
		const body = 'x'.repeat(240 * 1024);
		for (let index = 0; index < 40; index += 1) {
			expectPage(
				authority.sync(
					syncRound(token(`replica-${index}`), [
						create(`skill-${index}`, { title: body }),
					]),
				),
			);
		}

		const first = expectPage(authority.sync(syncPull(token('reader'))));
		expect(first.hasMore).toBeTrue();
		expect(first.entries.length).toBeLessThan(40);
		expect(encodedJsonBytes(first)).toBeLessThanOrEqual(
			RECORD_SYNC_ADMISSION_LIMITS.encodedPageBytes,
		);

		const second = expectPage(
			authority.sync(syncPull(token('reader', 0, first.token.checkpoint))),
		);
		expect(second.hasMore).toBeFalse();
		expect(first.entries.length + second.entries.length).toBe(40);
	});
});

test('rounds are accepted before stale-client snapshot bootstrap', async () => {
	await withAuthority(async (authority) => {
		authority.sync(
			syncRound(token('writer'), [create('skill-1'), remove('skill-1')]),
		);
		const manifest = await authority.publishSnapshot({
			maxChunkBytes: 512 * 1024,
		});
		if (!manifest) throw new Error('Expected snapshot publication');
		authority.compactDeletionsThrough(manifest.head);

		// A below-floor replica submits a round: round first, snapshot second.
		const response = authority.sync(
			syncRound(token('stale'), [create('skill-2', { title: 'Offline' })]),
		);
		if (!response.ok || !response.snapshotRequired) {
			throw new Error('Expected a snapshot-required response');
		}
		expect(response.resumeToken).toEqual({
			replicaId: 'stale',
			acceptedRound: 1,
			checkpoint: manifest.head,
		});
		expect(authority.inspect().rows).toMatchObject([
			{ rowId: 'skill-2', value: { title: 'Offline' } },
		]);
		// The fold landed above the snapshot head, so resuming pages deliver it.
		const resumed = expectPage(authority.sync(syncPull(response.resumeToken)));
		expect(resumed.entries).toMatchObject([{ kind: 'row', rowId: 'skill-2' }]);
	});
});

test('published snapshot covers compacted deletion markers across reopen', async () => {
	const sqlite = new Database(':memory:');
	try {
		const adapter = createBunSqliteAdapter(sqlite);
		const authority = openRecordAuthority({ database: adapter, sha256 });
		authority.sync(
			syncRound(token('replica-a'), [create('skill-1'), remove('skill-1')]),
		);
		const manifest = await authority.publishSnapshot({
			maxChunkBytes: 512 * 1024,
		});
		if (!manifest) throw new Error('Expected snapshot publication');
		expect(authority.compactDeletionsThrough(2)).toBe(2);

		const reopened = openRecordAuthority({ database: adapter, sha256 });
		expect(reopened.sync(syncPull(token('fresh')))).toEqual({
			kind: 'sync',
			ok: true,
			snapshotRequired: true,
			resumeToken: { replicaId: 'fresh', acceptedRound: 0, checkpoint: 2 },
			manifest,
		});
		const chunk = reopened.snapshotChunk({
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			kind: 'snapshotChunk',
			generation: manifest.generation,
			index: 0,
		});
		expect(chunk).toMatchObject({ ok: true, chunk: { rows: [], bodies: [] } });
	} finally {
		sqlite.close();
	}
});

test('injected merge compacts a body log prefix into one baseline', async () => {
	const sqlite = new Database(':memory:');
	try {
		const decode = (value: string) =>
			Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
		const authority = openRecordAuthority({
			database: createBunSqliteAdapter(sqlite),
			sha256,
			mergeBodyUpdates: (updates) => {
				const merged = new Uint8Array(
					updates.reduce((total, update) => total + update.length, 0),
				);
				let offset = 0;
				for (const update of updates) {
					merged.set(update, offset);
					offset += update.length;
				}
				return merged;
			},
		});
		authority.sync(
			syncRound(token('replica-a'), [
				create('note-1'),
				bodyAppend('note-1', btoa('one')),
				bodyAppend('note-1', btoa('two')),
			]),
		);
		const manifest = await authority.publishSnapshot({
			maxChunkBytes: 512 * 1024,
		});
		if (!manifest) throw new Error('Expected snapshot publication');
		authority.compactDeletionsThrough(manifest.head);

		const log = authority.inspect().bodyLog;
		expect(log).toHaveLength(1);
		expect(log[0]?.lastServerSequence).toBe(3);
		const chunk = authority.snapshotChunk({
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			kind: 'snapshotChunk',
			generation: manifest.generation,
			index: 0,
		});
		if (!chunk.ok) throw new Error('Expected the snapshot chunk');
		// The snapshot was published before compaction, so it carries the
		// original two updates; the live log carries the merged baseline.
		expect(chunk.chunk.bodies).toHaveLength(2);
		const baseline = sqlite
			.query<{ update_b64: string }, []>(
				'SELECT update_b64 FROM record_sync_body_updates',
			)
			.get();
		expect(new TextDecoder().decode(decode(baseline?.update_b64 ?? ''))).toBe(
			'onetwo',
		);
	} finally {
		sqlite.close();
	}
});

test('a checkpoint ahead of the authority is rejected before any fold', () => {
	withAuthority((authority) => {
		expect(() =>
			authority.sync(syncRound(token('replica-a', 0, 99), [create('skill-1')])),
		).toThrow('Sync checkpoint is ahead of the authority');
		expect(authority.inspect().head).toBe(0);
		expect(authority.inspect().replicaRounds).toEqual({});
	});
});

test('authority stores no schema, actor, KV, or mutation log tables', () => {
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
			'record_sync_body_updates',
			'record_sync_deletions',
			'record_sync_meta',
			'record_sync_replicas',
			'record_sync_rows',
			'record_sync_snapshot_chunks',
			'record_sync_snapshot_manifest',
		]);
	} finally {
		sqlite.close();
	}
});

test('open refuses legacy authority storage instead of creating parallel state', () => {
	for (const legacyTable of ['record_sync_family', 'record_sync_actors']) {
		const sqlite = new Database(':memory:');
		try {
			sqlite.run(`
				CREATE TABLE ${legacyTable} (
					id INTEGER PRIMARY KEY,
					payload TEXT
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
	}
});
