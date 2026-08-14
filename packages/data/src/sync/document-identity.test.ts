/**
 * A cursor is a position, not a membership (ADR-0231).
 *
 * Admission used to greet cursor zero as "no commitment: this document grew
 * alone, and merging an independent document is the one cross-document merge
 * that is safe". Two states wore that cursor while holding a commitment, and
 * each one, driven through a replace built with the REAL rebuild bytes
 * (`rebuildDocument`: re-minted identities, zero tombstones; a replacement
 * built from `encodeStateSince` masks both holes because its tombstones
 * travel), produced the exact corruption the design promises is structural:
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
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { defineWorkspace, type WorkspaceJson } from '@epicenter/workspace';
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
import { rebuildDocument } from './rebuild.js';

const workspace = defineWorkspace({
	namespace: 'so.epicenter.honeycrisp',
	tables: { notes: { title: 'string' } },
});

function expectOk<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (result.error !== null) throw result.error;
	return result.data as TValue;
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
	through: WorkspaceJson = workspace,
	database = createBunSqliteAdapter(new Database(':memory:')),
) {
	const db = createAccountStore({
		workspace: through,
		database,
	}) as unknown as DataOf<typeof workspace>;
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
	const database = createBunSqliteAdapter(new Database(':memory:'));
	const authority = openSyncAuthority({ database });
	const hub = createSyncHub({ authority, batch: 8 });
	return { wire, authority, hub };
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

	test('a replica holding old-document bytes is retired at its next dial, never merged across the break', () => {
		const { wire, authority, hub } = setup();
		const phone = openReplica('phone', hub, wire);
		phone.connect();
		const x = expectOk(phone.db.tables.notes.create({ title: 'X' }));
		phone.client.flush();
		wire.settle();

		// A second device syncs entry 1 in the client's order (stamp, then
		// bytes with the bookmark) and goes into the drawer: old-document
		// bytes, cursor 1, stamped.
		const drawerDb = createBunSqliteAdapter(new Database(':memory:'));
		{
			const drawerStore = createAccountStore({
				workspace: workspace,
				database: drawerDb,
			}).store;
			const entry = expectOk(authority.since(0, 10))[0];
			if (entry === undefined) throw new Error('the log holds no entry');
			expectOk(
				syncEngineOf(drawerStore).adoptDocumentIdentity(
					expectOk(authority.document()),
				),
			);
			expectOk(
				syncEngineOf(drawerStore).applyRemote(entry.bytes, {
					advanceTo: entry.seq,
				}),
			);
		}

		// X is deleted and the person rebuilds. The replace publishes a NEW
		// document: no X, and no tombstone of X, so a cross-document merge
		// would resurrect it.
		phone.db.tables.notes.delete(x.id);
		phone.client.flush();
		wire.settle();
		expectOk(phone.db.tables.notes.create({ title: 'kept' }));
		phone.client.flush();
		wire.settle();
		expectOk(
			authority.replace({
				fromDocument: expectOk(authority.document()),
				bytes: expectOk(rebuildDocument(phone.store)),
			}),
		);

		// The drawer device reboots from its durable file. Its stamp names the
		// retired document, so it is answered with the facts and nothing else.
		const drawer = openReplica('drawer', hub, wire, workspace, drawerDb);
		expect(drawer.titles()).toEqual(['X']);
		expect(drawer.connect()).toBe('retired');
		wire.settle();
		expect(drawer.client.status().superseded).toBe(true);
		// Nothing merged: its document is exactly what it held, and adoption is
		// its host's discard-and-reload, not a merge.
		expect(drawer.titles()).toEqual(['X']);
	});
});

describe('workspace bootstrap names a document before any workspace write', () => {
	test('a pristine replica bootstraps, then its first push survives a reopen', () => {
		const { wire, authority, hub } = setup();
		const database = createBunSqliteAdapter(new Database(':memory:'));
		const replica = openReplica('replica', hub, wire, workspace, database);
		expect(replica.client.document()).toBeUndefined();

		// The empty store receives the authority name, persists it, and reconnects
		// through the equality door before it is allowed to author workspace data.
		expect(replica.connect()).toBe('admitted');
		wire.settle();
		expect(replica.client.document()).toBe(expectOk(authority.document()));
		expectOk(replica.db.tables.notes.create({ title: 'X' }));
		replica.client.flush();
		wire.settle();

		// Durable, not a session fact: a store reopened from the same file
		// still knows which document its bytes belong to.
		const reopened = createAccountStore({ workspace: workspace, database });
		expect(syncEngineOf(reopened.store).documentIdentity()).toBe(
			expectOk(authority.document()),
		);
	});

	test('a pushed-but-unacked replica is retired at its next dial, and a deleted row stays deleted', () => {
		const { wire, authority, hub } = setup();

		// The drawer first bootstraps, then authors X, pushes, and the socket dies
		// before the ack. The push LANDED; the cursor never moved.
		const drawer = openReplica('drawer', hub, wire);
		expect(drawer.connect()).toBe('admitted');
		wire.settle();
		expectOk(drawer.db.tables.notes.create({ title: 'X' }));
		drawer.client.flush();
		// The push lands, then its acknowledgement dies with the socket.
		wire.step(1);
		expect(expectOk(authority.head())).toBe(1);
		drawer.disconnect();
		wire.settle(); // drain the discarded ack
		expect(drawer.client.status().cursor).toBe(0);
		expect(drawer.client.document()).toBe(expectOk(authority.document()));

		// The phone receives X, deletes it, and rebuilds. New document: no X.
		const phone = openReplica('phone', hub, wire);
		phone.connect();
		wire.settle();
		expect(phone.titles()).toEqual(['X']);
		const row = phone.db.tables.notes.list().rows[0];
		if (row === undefined) throw new Error('the phone holds no row');
		phone.db.tables.notes.delete(row.id);
		phone.client.flush();
		wire.settle();
		expectOk(
			authority.replace({
				fromDocument: expectOk(authority.document()),
				bytes: expectOk(rebuildDocument(phone.store)),
			}),
		);
		phone.disconnect();

		// The drawer returns declaring the retired document. Before the stamp
		// existed this dial was greeted as a fresh install, its outbox
		// republished the retired document's bytes, and deleted X resurrected
		// on every device.
		expect(drawer.connect()).toBe('retired');
		wire.settle();
		expect(drawer.client.status().superseded).toBe(true);
		drawer.client.flush();
		wire.settle();

		// A later device on the new document never sees X: the retired bytes
		// landed nowhere.
		const laptop = openReplica('laptop', hub, wire);
		laptop.connect();
		wire.settle();
		expect(laptop.titles()).toEqual([]);
	});

	test('local workspace work before bootstrap is discarded, never stamped and sent', () => {
		const { wire, authority, hub } = setup();
		const replica = openReplica('replica', hub, wire);
		expectOk(replica.db.tables.notes.create({ title: 'held' }));
		replica.connect();

		// The announcement proves this local state never adopted a workspace
		// document. It is discarded by the host, not promoted by the protocol.
		replica.client.flush();
		expect(expectOk(authority.head())).toBe(0);
		expect(replica.client.document()).toBeUndefined();

		wire.settle();
		expect(replica.client.status().superseded).toBe(true);
		expect(expectOk(authority.head())).toBe(0);
	});

	test('CONTROL: a pristine install adopts before writing', () => {
		const { wire, authority, hub } = setup();
		const phone = openReplica('phone', hub, wire);
		phone.connect();
		expectOk(phone.db.tables.notes.create({ title: 'kept' }));
		phone.client.flush();
		wire.settle();
		expectOk(
			authority.replace({
				fromDocument: expectOk(authority.document()),
				bytes: expectOk(rebuildDocument(phone.store)),
			}),
		);

		// A new workspace replica has no local document at all. It bootstraps
		// before it can author workspace work, so there is no cross-document
		// merge exception.
		const fresh = openReplica('fresh', hub, wire);
		expect(fresh.connect()).toBe('admitted');
		wire.settle();
		expectOk(fresh.db.tables.notes.create({ title: 'fresh install note' }));
		fresh.client.flush();
		wire.settle();
		expect(fresh.titles()).toEqual(['fresh install note', 'kept']);
		expect(fresh.client.status().superseded).toBe(false);
	});
});

describe('the cutover: pre-identity local state is reset, never merged', () => {
	test('a file holding state without the format certificate is wiped at open and rejoins fresh', () => {
		const { wire, authority, hub } = setup();
		const phone = openReplica('phone', hub, wire);
		phone.connect();
		expectOk(phone.db.tables.notes.create({ title: 'current' }));
		phone.client.flush();
		wire.settle();

		// A store file from before the document identity: it holds real state
		// (which may descend from any document, including a retired one) and
		// no certificate saying which. Modelled exactly: a certified file with
		// its `_meta` rows removed is byte-for-byte the old format.
		const database = createBunSqliteAdapter(new Database(':memory:'));
		{
			const old = createAccountStore({ workspace: workspace, database });
			expectOk(old.tables.notes.create({ title: 'untrusted old note' }));
		}
		database.run('DELETE FROM _meta');

		// The open is the cutover: untrusted whole, wiped whole. A missing
		// identity must never read as a fresh install when state exists.
		const reopened = openReplica('reopened', hub, wire, workspace, database);
		expect(reopened.titles()).toEqual([]);
		expect(reopened.client.status().cursor).toBe(0);
		expect(reopened.client.document()).toBeUndefined();

		// And the reset replica rejoins as what it now is, a fresh install:
		// admitted from zero, adopting the current document.
		expect(reopened.connect()).toBe('admitted');
		wire.settle();
		expect(reopened.titles()).toEqual(['current']);
		expect(reopened.client.document()).toBe(expectOk(authority.document()));
	});

	test('CONTROL: a certified file reopens intact', () => {
		const database = createBunSqliteAdapter(new Database(':memory:'));
		{
			const first = createAccountStore({ workspace: workspace, database });
			expectOk(first.tables.notes.create({ title: 'kept across reopen' }));
		}
		const reopened = createAccountStore({ workspace: workspace, database });
		expect(reopened.tables.notes.list().rows.map((row) => row.title)).toEqual([
			'kept across reopen',
		]);
	});
});
