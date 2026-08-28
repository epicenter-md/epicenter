import { field } from '@epicenter/data/definition';
/**
 * A cursor is a position, not a membership (ADR-0231).
 *
 * Admission used to greet cursor zero as "no commitment: this document grew
 * alone, and merging an independent document is the one cross-document merge
 * that is safe". Two states wore that cursor while holding a commitment, and
 * each one, driven through a stale identity, produced the exact corruption
 * the design promises is structural:
 * silently merging across the break, and resurrecting a deleted row into the
 * replacement document. The fix is the document identity: the authority names
 * the document its log describes, a replica stamps the identity its state
 * belongs to at first entanglement, and admission is equality. These tests
 * reproduce the two states and pin the door.
 *
 * - Receive direction: the stamp commits durably at the announcement, before
 *   any foreign byte; entries and snapshots are dropped until it has. Bytes
 *   and bookmark then commit in one transaction, so no crash can leave
 *   foreign bytes behind a dial that still claims a fresh install.
 * - Publish direction: a push that landed while the ack died with the socket
 *   left the authority's log holding this replica's bytes and the replica's
 *   durable cursor at zero. No push leaves an unstamped replica: the stamp
 *   precedes the first push, and travels on every later dial.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { type DataDefinition, defineData } from '@epicenter/data/definition';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import type { Result } from 'wellcrafted/result';

import {
	createAccountStore,
	type DataOf,
	syncEngineOf,
} from '../store/store.js';
import { openSyncAuthority } from './authority.js';
import { createSyncClient } from './client.js';
import { encodeFrame } from './frames.js';
import { createSyncHub, type HubConnection } from './hub.js';

const database = defineData({
	id: 'so.epicenter.honeycrisp',
	kv: {},
	tables: { notes: { fields: { title: field.string() } } },
});

function expectOk<TValue, TError>(
	result: Result<TValue, TError> | TValue,
): TValue {
	if (
		typeof result === 'object' &&
		result !== null &&
		'data' in result &&
		'error' in result
	) {
		const outcome = result as Result<TValue, TError>;
		if (outcome.error !== null) throw outcome.error;
		return outcome.data as TValue;
	}
	return result as TValue;
}

function createWire() {
	const queue: (() => void)[] = [];
	return {
		defer(task: () => void) {
			queue.push(task);
		},
		settle() {
			let guard = 0;
			while (queue.length > 0) {
				guard += 1;
				if (guard > 10_000) throw new Error('the wire never settled');
				(queue.shift() as () => void)();
			}
		},
		/** Deliver `count` messages and leave the rest queued, like a dying socket. */
		step(count = 1) {
			for (let index = 0; index < count && queue.length > 0; index += 1) {
				(queue.shift() as () => void)();
			}
		},
	};
}
type Wire = ReturnType<typeof createWire>;

function openReplica(
	label: string,
	hub: ReturnType<typeof createSyncHub>,
	wire: Wire,
	through: DataDefinition = database,
	sqlite = createBunSqliteAdapter(new Database(':memory:')),
) {
	const db = createAccountStore({
		definition: through,
		sqlite,
	}) as unknown as DataOf<typeof database>;
	const store = db.store;
	const client = createSyncClient({
		store,
		idleMs: 0,
		schedule: (task) => {
			wire.defer(task);
			return () => undefined;
		},
	});
	let generation = 0;
	const connection: HubConnection = {
		cursor: client.cursor(),
		document: client.document(),
		send: (bytes) => {
			const sentOn = generation;
			wire.defer(() => {
				if (sentOn === generation) client.receive(bytes);
			});
		},
	};
	const socket = {
		send: (bytes: Uint8Array) => {
			const sentOn = generation;
			wire.defer(() => {
				if (sentOn === generation) hub.receive(connection, bytes);
			});
		},
	};
	return {
		label,
		store,
		db,
		client,
		connect() {
			connection.cursor = client.cursor();
			connection.document = syncEngineOf(store).documentIdentity();
			const admission = hub.join(connection);
			client.attach(socket);
			if (admission === 'bootstrap') {
				wire.settle();
				if (client.status().superseded) return admission;
				connection.cursor = client.cursor();
				connection.document = client.document();
				return hub.join(connection);
			}
			return admission;
		},
		disconnect() {
			generation += 1;
			hub.leave(connection);
			client.detach();
		},
		titles: () =>
			db.tables.notes
				.list()
				.rows.map((row) => row.title)
				.sort(),
	};
}

function setup() {
	const wire = createWire();
	const sqlite = createBunSqliteAdapter(new Database(':memory:'));
	const authority = openSyncAuthority({ sqlite });
	const hub = createSyncHub({ authority, batch: 8 });
	return { wire, sqlite, authority, hub };
}

describe('the receive half: the stamp precedes every foreign byte', () => {
	test('the announcement stamps durably before any byte, and bytes then move with the bookmark', () => {
		const { wire, authority, hub } = setup();
		const phone = openReplica('phone', hub, wire);
		phone.connect();
		expectOk(phone.db.tables.notes.create({ title: 'X' }));
		phone.client.flush();
		wire.settle();

		// A fresh client hears the announcement alone: the stamp is durable
		// before a single foreign byte exists to apply.
		const victim = openReplica('victim', hub, wire);
		const name = expectOk(authority.document());
		victim.client.receive(encodeFrame({ kind: 'document', id: name }));
		expect(syncEngineOf(victim.store).documentIdentity()).toBe(name);
		expect(syncEngineOf(victim.store).cursor()).toBe(0);

		// The entry then commits bytes and bookmark as one step: after it there
		// is no gap for a crash to land in.
		const entry = expectOk(authority.since(0, 10))[0];
		if (entry === undefined) throw new Error('the log holds no entry');
		victim.client.receive(
			encodeFrame({
				kind: 'entry',
				seq: entry.seq,
				chunk: 0,
				chunks: 1,
				bytes: entry.bytes,
			}),
		);
		expect(syncEngineOf(victim.store).cursor()).toBe(entry.seq);
		expect(victim.titles()).toEqual(['X']);
	});

	test('bytes arriving before any announcement are dropped, never applied unstamped', () => {
		const { wire, authority, hub } = setup();
		const phone = openReplica('phone', hub, wire);
		phone.connect();
		expectOk(phone.db.tables.notes.create({ title: 'X' }));
		phone.client.flush();
		wire.settle();

		// A server that delivered history before naming its document would
		// manufacture the unbound-with-bytes state admission trusts to be
		// impossible. The client refuses the bytes instead.
		const victim = openReplica('victim', hub, wire);
		const entry = expectOk(authority.since(0, 10))[0];
		if (entry === undefined) throw new Error('the log holds no entry');
		victim.client.receive(
			encodeFrame({
				kind: 'entry',
				seq: entry.seq,
				chunk: 0,
				chunks: 1,
				bytes: entry.bytes,
			}),
		);
		expect(victim.titles()).toEqual([]);
		expect(syncEngineOf(victim.store).cursor()).toBe(0);
		expect(syncEngineOf(victim.store).documentIdentity()).toBeUndefined();
	});

	test('a replica holding a stale document is retired at its next dial', () => {
		const { wire, sqlite, authority, hub } = setup();
		const phone = openReplica('phone', hub, wire);
		phone.connect();
		expectOk(phone.db.tables.notes.create({ title: 'X' }));
		phone.client.flush();
		wire.settle();

		expectOk(authority.document());
		sqlite.run(
			"UPDATE _meta SET value = ? WHERE key = 'document'",
			[crypto.randomUUID()],
		);

		phone.disconnect();
		expect(phone.connect()).toBe('retired');
		wire.settle();
		expect(phone.client.status().superseded).toBe(true);
		expect(phone.titles()).toEqual(['X']);
	});
});

describe('database bootstrap names a document before any database write', () => {
	test('a pristine replica bootstraps, then its first push survives a reopen', () => {
		const { wire, authority, hub } = setup();
		const sqlite = createBunSqliteAdapter(new Database(':memory:'));
		const replica = openReplica('replica', hub, wire, database, sqlite);
		expect(replica.client.document()).toBeUndefined();

		// The empty store receives the authority name, persists it, and reconnects
		// through the equality door before it is allowed to author database data.
		expect(replica.connect()).toBe('admitted');
		wire.settle();
		expect(replica.client.document()).toBe(expectOk(authority.document()));
		expectOk(replica.db.tables.notes.create({ title: 'X' }));
		replica.client.flush();
		wire.settle();

		// Durable, not a session fact: a store reopened from the same file
		// still knows which document its bytes belong to.
		const reopened = createAccountStore({ definition: database, sqlite });
		expect(syncEngineOf(reopened.store).documentIdentity()).toBe(
			expectOk(authority.document()),
		);
	});


	test('local database work before bootstrap is discarded, never stamped and sent', () => {
		const { wire, authority, hub } = setup();
		const replica = openReplica('replica', hub, wire);
		expectOk(replica.db.tables.notes.create({ title: 'held' }));
		replica.connect();

		// The announcement proves this local state never adopted a database
		// document. It is discarded by the host, not promoted by the protocol.
		replica.client.flush();
		expect(expectOk(authority.head())).toBe(0);
		expect(replica.client.document()).toBeUndefined();

		wire.settle();
		expect(replica.client.status().superseded).toBe(true);
		expect(expectOk(authority.head())).toBe(0);
	});


});

describe('a record under an older shape is not addressed', () => {
	/*
	 * There used to be a test here for a file holding state without a format
	 * certificate being wiped at open. That behavior is gone, along with the
	 * certificate: the storage generation is part of the address now
	 * (`epicenter/v1/...`), so a record written under an older shape is not
	 * detected and wiped, it is somewhere nothing opens. There is no code path
	 * left to exercise.
	 *
	 * The invariant that test also covered survives and is checked elsewhere:
	 * a store holding state refuses the identity stamp (`Unstampable`), so a
	 * missing identity can never read as a fresh install.
	 */

	test('CONTROL: a certified file reopens intact', () => {
		const sqlite = createBunSqliteAdapter(new Database(':memory:'));
		{
			const first = createAccountStore({ definition: database, sqlite });
			expectOk(first.tables.notes.create({ title: 'kept across reopen' }));
		}
		const reopened = createAccountStore({ definition: database, sqlite });
		expect(reopened.tables.notes.list().rows.map((row) => row.title)).toEqual([
			'kept across reopen',
		]);
	});
});
