/**
 * Workspace Authority Document Store Tests
 *
 * Verifies Yjs 14 validation, bounded complete state, and update-log
 * compaction inside the authority-owned SQLite schema.
 *
 * Key behaviors:
 * - malformed and oversized updates store no bytes
 * - merged-state overflow closes only its sender through the real hub
 * - bounded update logs compact into one replayable V2 snapshot
 * - exact accepted V2 updates hydrate the same document state
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
	CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
	type CurrentStateWireRowIntent,
	rowRoundDigest,
} from '@epicenter/row-sync';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import {
	DOCUMENT_BACKSTOP_CLOSE_CODE,
	DOCUMENT_BOUND,
	type DocumentFrame,
} from '@epicenter/sync/document-v3';
import * as Y from '@y/y';
import {
	createDocumentHubCore,
	type DocumentHubSocket,
} from '../document-hub/core.js';
import {
	AUTHORITY_DOCUMENT_COMPACTION,
	openAccountRowAuthority,
} from './authority.js';

const ROW_ID = 'abc123def456ghi789jkl012';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const ADDRESS = { table: 'notes', rowId: ROW_ID };

function setup() {
	const database = new Database(':memory:');
	const authority = openAccountRowAuthority({
		database: createBunSqliteAdapter(database),
	}).workspace('workspace');
	const intents: CurrentStateWireRowIntent[] = [
		{
			kind: 'create',
			table: ADDRESS.table,
			rowId: ADDRESS.rowId,
			fields: { title: 'Document owner' },
		},
	];
	authority.push({
		protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
		kind: 'push',
		replicaId: REPLICA_ID,
		round: 1,
		requestDigest: rowRoundDigest(intents),
		intents,
	});
	return { authority, database };
}

test('malformed and oversized updates store no document bytes', () => {
	const { authority, database } = setup();
	try {
		expect(() =>
			authority.documents.appendIfLive(ADDRESS, new Uint8Array([1, 2, 3])),
		).toThrow('Invalid Yjs 14 document update');

		const oversized = new Y.Doc();
		try {
			oversized
				.get('editor')
				.insert(0, 'x'.repeat(DOCUMENT_BOUND.stateBytes + 1));
			const update = Y.encodeStateAsUpdateV2(oversized);
			expect(authority.documents.appendIfLive(ADDRESS, update)).toBe(
				'too-large',
			);
		} finally {
			oversized.destroy();
		}

		expect(authority.documents.openIfLive(ADDRESS)).toEqual([]);
		expect(
			database
				.query<{ count: number }, []>(
					`SELECT COUNT(*) AS count FROM (
						SELECT table_name FROM row_authority_document_snapshots
						UNION ALL
						SELECT table_name FROM row_authority_document_updates
					)`,
				)
				.get()?.count,
		).toBe(0);
	} finally {
		database.close();
	}
});

test('a row that is not live refuses append before candidate validation', () => {
	const { authority, database } = setup();
	try {
		const oversized = new Uint8Array(DOCUMENT_BOUND.stateBytes + 1);
		expect(
			authority.documents.appendIfLive(
				{ table: 'notes', rowId: 'absentabsentabsentabsent' },
				oversized,
			),
		).toBe('refused');
		expect(
			authority.documents.openIfLive({
				table: 'notes',
				rowId: 'absentabsentabsentabsent',
			}),
		).toBeUndefined();

		const intents: CurrentStateWireRowIntent[] = [
			{ kind: 'delete', table: ADDRESS.table, rowId: ADDRESS.rowId },
		];
		expect(
			authority.push({
				protocolMajor: CURRENT_STATE_ROW_SYNC_PROTOCOL_MAJOR,
				kind: 'push',
				replicaId: REPLICA_ID,
				round: 2,
				requestDigest: rowRoundDigest(intents),
				intents,
			}).result,
		).toBe('accepted');
		expect(authority.documents.openIfLive(ADDRESS)).toBeUndefined();
		expect(authority.documents.appendIfLive(ADDRESS, oversized)).toBe(
			'refused',
		);
	} finally {
		database.close();
	}
});

test('merged-state overflow closes only its sender and rehydrates committed state', () => {
	const { authority, database } = setup();
	const committedSource = new Y.Doc();
	const rejectedSource = new Y.Doc();
	try {
		committedSource.get('left').insert(0, 'x'.repeat(550_000));
		const committed = Y.encodeStateAsUpdateV2(committedSource);
		expect(authority.documents.appendIfLive(ADDRESS, committed)).toBe(
			'appended',
		);
		const before = authority.documents.openIfLive(ADDRESS);

		const hub = createDocumentHubCore({
			address: ADDRESS,
			store: authority.documents,
		});
		const alice = createSocket();
		const bob = createSocket();
		const carol = createSocket();
		const emptyStateVector = Y.encodeStateVector(new Y.Doc());
		hub.connect(alice, emptyStateVector);
		hub.connect(bob, emptyStateVector);
		alice.messages.length = 0;
		bob.messages.length = 0;

		rejectedSource.get('right').insert(0, 'y'.repeat(550_000));
		const rejected = Y.encodeStateAsUpdateV2(rejectedSource);
		expect(rejected.byteLength).toBeLessThan(DOCUMENT_BOUND.stateBytes);
		hub.receive(alice, { kind: 'update', update: rejected });

		expect(alice.messages).toEqual([]);
		expect(alice.closes).toEqual([
			{ code: DOCUMENT_BACKSTOP_CLOSE_CODE, reason: 'too-large' },
		]);
		expect(bob.messages).toEqual([]);
		expect(bob.closes).toEqual([]);
		expect(hub.connectionCount).toBe(1);
		expect(authority.documents.openIfLive(ADDRESS)).toEqual(before);

		hub.connect(carol, emptyStateVector);
		const hydrated = new Y.Doc();
		try {
			Y.applyUpdateV2(hydrated, expectSyncResponse(carol.messages));
			expect(hydrated.get('left').toString()).toBe('x'.repeat(550_000));
			expect(hydrated.get('right').toString()).toBe('');
		} finally {
			hydrated.destroy();
		}
	} finally {
		committedSource.destroy();
		rejectedSource.destroy();
		database.close();
	}
});

test('update threshold compacts into one replayable V2 snapshot', () => {
	const { authority, database } = setup();
	const source = new Y.Doc();
	try {
		const updates: Uint8Array[] = [];
		source.on('updateV2', (update: Uint8Array) => {
			updates.push(Uint8Array.from(update));
		});
		const editor = source.get('editor');
		for (
			let index = 0;
			index < AUTHORITY_DOCUMENT_COMPACTION.updatesBeforeCompaction;
			index += 1
		) {
			editor.insert(editor.length, 'x');
			const update = updates.at(-1);
			if (!update) throw new Error('Expected one incremental update');
			expect(authority.documents.appendIfLive(ADDRESS, update)).toBe(
				'appended',
			);
		}

		expect(
			database
				.query<{ count: number }, []>(
					'SELECT COUNT(*) AS count FROM row_authority_document_updates',
				)
				.get()?.count,
		).toBe(0);
		expect(
			database
				.query<{ count: number }, []>(
					'SELECT COUNT(*) AS count FROM row_authority_document_snapshots',
				)
				.get()?.count,
		).toBe(1);

		const hydrated = new Y.Doc();
		try {
			for (const update of authority.documents.openIfLive(ADDRESS) ?? []) {
				Y.applyUpdateV2(hydrated, update);
			}
			expect(hydrated.get('editor').toString()).toBe('x'.repeat(64));
		} finally {
			hydrated.destroy();
		}
	} finally {
		source.destroy();
		database.close();
	}
});

test('struct-dense post-state refuses while committed state survives', () => {
	const { authority, database } = setup();
	const dense = new Y.Doc();
	try {
		// Head inserts in one transaction never merge, so struct count exceeds
		// the ceiling while bytes stay far below the byte bound.
		dense.transact(() => {
			for (let i = 0; i < DOCUMENT_BOUND.stateStructs + 1; i++) {
				dense.get('t').insert(0, 'z');
			}
		});
		const candidate = Y.encodeStateAsUpdateV2(dense);
		expect(candidate.byteLength).toBeLessThan(DOCUMENT_BOUND.stateBytes);
		expect(authority.documents.appendIfLive(ADDRESS, candidate)).toBe(
			'too-large',
		);
		expect(authority.documents.openIfLive(ADDRESS)).toEqual([]);
	} finally {
		dense.destroy();
		database.close();
	}
});

test('candidates past the struct limit refuse before hydration and apply', () => {
	const { authority, database } = setup();
	const committedSource = new Y.Doc();
	const attack = new Y.Doc();
	try {
		committedSource.get('t').insert(0, 'committed');
		const committed = Y.encodeStateAsUpdateV2(committedSource);
		expect(authority.documents.appendIfLive(ADDRESS, committed)).toBe(
			'appended',
		);
		const before = authority.documents.openIfLive(ADDRESS);

		attack.transact(() => {
			for (let i = 0; i < DOCUMENT_BOUND.stateStructs + 2_000; i++) {
				attack.get('t').insert(0, 'z');
			}
		});
		expect(
			authority.documents.appendIfLive(
				ADDRESS,
				Y.encodeStateAsUpdateV2(attack),
			),
		).toBe('too-large');
		expect(authority.documents.openIfLive(ADDRESS)).toEqual(before);
	} finally {
		committedSource.destroy();
		attack.destroy();
		database.close();
	}
});

test('a deletion shrinks an at-bound document and future growth resumes', () => {
	const { authority, database } = setup();
	const source = new Y.Doc();
	try {
		source.get('t').insert(0, 'x'.repeat(1_040_000));
		expect(
			authority.documents.appendIfLive(
				ADDRESS,
				Y.encodeStateAsUpdateV2(source),
			),
		).toBe('appended');

		const grownFrom = Y.encodeStateVector(source);
		source.get('t').insert(0, 'y'.repeat(50_000));
		expect(
			authority.documents.appendIfLive(
				ADDRESS,
				Y.encodeStateAsUpdateV2(source, grownFrom),
			),
		).toBe('too-large');

		// Rebuild the client's view from committed state, delete content, and
		// verify the small delete update is admitted and shrinks the state.
		const client = new Y.Doc();
		for (const part of authority.documents.openIfLive(ADDRESS) ?? []) {
			Y.applyUpdateV2(client, part);
		}
		const beforeDelete = Y.encodeStateVector(client);
		client.get('t').delete(0, 600_000);
		const deletion = Y.encodeStateAsUpdateV2(client, beforeDelete);
		expect(deletion.byteLength).toBeLessThan(1_000);
		expect(authority.documents.appendIfLive(ADDRESS, deletion)).toBe(
			'appended',
		);

		const rehydrated = new Y.Doc();
		for (const part of authority.documents.openIfLive(ADDRESS) ?? []) {
			Y.applyUpdateV2(rehydrated, part);
		}
		expect(
			Y.encodeStateAsUpdateV2(rehydrated).byteLength,
		).toBeLessThan(DOCUMENT_BOUND.stateBytes / 2);
		client.destroy();
		rehydrated.destroy();
	} finally {
		source.destroy();
		database.close();
	}
});

function createSocket(): DocumentHubSocket & {
	messages: DocumentFrame[];
	closes: { code: number; reason: string }[];
} {
	const messages: DocumentFrame[] = [];
	const closes: { code: number; reason: string }[] = [];
	return {
		messages,
		closes,
		send(frame) {
			messages.push(frame);
		},
		close(code, reason) {
			closes.push({ code, reason });
		},
	};
}

function expectSyncResponse(frames: readonly DocumentFrame[]): Uint8Array {
	const frame = frames.find((candidate) => candidate.kind === 'sync-response');
	if (frame?.kind !== 'sync-response') {
		throw new Error('Expected sync response frame');
	}
	return frame.update;
}
