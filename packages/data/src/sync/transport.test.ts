/**
 * Two replicas and one authority, wired through in-process sockets.
 *
 * The client, the hub and the authority here are the ones that get deployed;
 * only the socket is a stand-in, and it is a queue that delivers in order
 * exactly like a real one. That distinction is the point. A cursor rule on this
 * branch once "worked" in a simulation where nothing was ever delivered, so
 * every test that claims something arrived asserts on the RECEIVING replica's
 * rows, never on a counter kept by the harness.
 */
import { defineLens } from '@epicenter/lens/lens';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';
import type { Result } from 'wellcrafted/result';

import { createStore } from '../store/store.js';
import { openSyncAuthority } from './authority.js';
import { encodeFrame, intoChunks } from './frames.js';
import { createSyncHub, type HubConnection } from './hub.js';
import { createSyncClient } from './client.js';

const lens = defineLens({
	namespace: 'so.epicenter.honeycrisp',
	tables: { notes: { title: 'string' } },
});

function expectOk<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (result.error !== null) throw result.error;
	return result.data as TValue;
}

/**
 * A network that delivers in order, and only when told to.
 *
 * Nothing is asynchronous, so a test can hold messages in the wire and assert
 * on what each side believes while they are still there.
 */
function createWire() {
	const queue: (() => void)[] = [];
	return {
		defer(task: () => void) {
			queue.push(task);
		},
		/** Deliver everything, including whatever delivery itself produces. */
		settle() {
			let guard = 0;
			while (queue.length > 0) {
				if ((guard += 1) > 10_000) throw new Error('the wire never settled');
				(queue.shift() as () => void)();
			}
		},
		inFlight: () => queue.length,
	};
}

type Wire = ReturnType<typeof createWire>;

function openReplica(label: string, hub: ReturnType<typeof createSyncHub>, wire: Wire) {
	const database = createBunSqliteAdapter(new Database(':memory:'));
	const store = createStore({ database });
	const db = expectOk(store.bind(lens));
	const client = createSyncClient({
		store,
		idleMs: 0,
		// The idle timer fires through the wire, so a test controls when a
		// coalesced batch leaves rather than waiting on a clock.
		schedule: (task) => {
			wire.defer(task);
			return () => undefined;
		},
	});
	const connection: HubConnection = {
		cursor: client.cursor(),
		send: (bytes) => wire.defer(() => client.receive(bytes)),
	};
	const socket = { send: (bytes: Uint8Array) => wire.defer(() => hub.receive(connection, bytes)) };

	return {
		label,
		store,
		db,
		client,
		connection,
		socket,
		connect() {
			connection.cursor = client.cursor();
			hub.join(connection);
			client.attach(socket);
		},
		disconnect() {
			hub.leave(connection);
			client.detach();
		},
		titles: () =>
			expectOk(db.notes.list())
				.rows.map((row) => row.title)
				.sort(),
	};
}

function openAuthority() {
	const database = createBunSqliteAdapter(new Database(':memory:'));
	const authority = openSyncAuthority({ database });
	return { authority, hub: createSyncHub({ authority, batch: 8 }) };
}

function setup() {
	const wire = createWire();
	const { authority, hub } = openAuthority();
	const phone = openReplica('phone', hub, wire);
	const laptop = openReplica('laptop', hub, wire);
	return { wire, authority, hub, phone, laptop };
}

describe('two replicas converge through a log of opaque bytes', () => {
	test('a row created on one device arrives on the other', () => {
		const { wire, phone, laptop } = setup();
		phone.connect();
		laptop.connect();

		expectOk(phone.db.notes.create({ title: 'Groceries' }));
		phone.client.flush();
		wire.settle();

		expect(laptop.titles()).toEqual(['Groceries']);
		expect(laptop.client.status().unresolvedDependencies).toBe(false);
	});

	test('CONTROL: it does NOT arrive when the wire never delivers', () => {
		// The control this whole file exists for. An earlier experiment on this
		// branch passed because its harness delivered nothing and the assertion
		// happened to be about the sender. If this test ever fails, the one above
		// is measuring the harness rather than the transport.
		const { phone, laptop } = setup();
		phone.connect();
		laptop.connect();

		expectOk(phone.db.notes.create({ title: 'Groceries' }));
		phone.client.flush();
		// wire.settle() deliberately omitted.

		expect(laptop.titles()).toEqual([]);
	});

	test('edits made on both devices while connected merge', () => {
		const { wire, phone, laptop } = setup();
		phone.connect();
		laptop.connect();

		expectOk(phone.db.notes.create({ title: 'from the phone' }));
		expectOk(laptop.db.notes.create({ title: 'from the laptop' }));
		phone.client.flush();
		laptop.client.flush();
		wire.settle();

		expect(phone.titles()).toEqual(['from the laptop', 'from the phone']);
		expect(laptop.titles()).toEqual(phone.titles());
	});

	test('a device that was offline is caught up by the same path as a live relay', () => {
		const { wire, phone, laptop } = setup();
		phone.connect();

		for (let index = 0; index < 30; index += 1) {
			expectOk(phone.db.notes.create({ title: `note ${index}` }));
			phone.client.flush();
			wire.settle();
		}

		// The laptop has been absent the whole time and holds nothing.
		expect(laptop.titles()).toEqual([]);
		laptop.connect();
		wire.settle();

		expect(laptop.titles()).toHaveLength(30);
		expect(laptop.client.status().cursor).toBe(30);
		expect(laptop.client.status().unresolvedDependencies).toBe(false);
	});

	test('work authored offline reaches the authority on reconnect', () => {
		const { wire, phone, laptop } = setup();
		laptop.connect();

		// The phone never connects while it writes.
		expectOk(phone.db.notes.create({ title: 'written on a plane' }));
		expectOk(phone.db.notes.create({ title: 'also on a plane' }));
		phone.client.flush();
		wire.settle();
		expect(laptop.titles()).toEqual([]);

		phone.connect();
		wire.settle();

		expect(laptop.titles()).toEqual(['also on a plane', 'written on a plane']);
	});

	test('a deletion replicates, which a state vector could never have told us', () => {
		const { wire, phone, laptop } = setup();
		phone.connect();
		laptop.connect();
		const note = expectOk(phone.db.notes.create({ title: 'Groceries' }));
		phone.client.flush();
		wire.settle();
		expect(laptop.titles()).toEqual(['Groceries']);

		expectOk(phone.db.notes.delete(note.id));
		phone.client.flush();
		wire.settle();

		expect(laptop.titles()).toEqual([]);
	});

	test('prose written into a row document replicates with the row', () => {
		const { wire, phone, laptop } = setup();
		phone.connect();
		laptop.connect();
		const note = expectOk(phone.db.notes.create({ title: 'Groceries' }));
		const text = phone.db.notes.document(note.id)?.get('editor', 'text');
		if (text === undefined) throw new Error('the row has no document');
		text.applyDelta(text.change.insert('buy milk') as never);
		phone.client.flush();
		wire.settle();

		const arrived = laptop.db.notes.document(note.id)?.get('editor', 'text');
		expect(arrived?.length).toBe('buy milk'.length);
	});
});

describe('the ack is what makes a refusal visible', () => {
	test('an update is owed until the authority names its position', () => {
		const { wire, phone, laptop } = setup();
		phone.connect();
		laptop.connect();
		expectOk(phone.db.notes.create({ title: 'Groceries' }));
		phone.client.flush();

		// The push is on the wire and no ack has come back.
		expect(phone.client.status().inFlight).toBe(true);
		expect(phone.client.status().owed).toBeGreaterThan(0);

		wire.settle();

		expect(phone.client.status().inFlight).toBe(false);
		expect(phone.client.status().owed).toBe(0);
		expect(phone.client.status().cursor).toBe(1);
	});

	test('a refused update is held, reported, and never silently dropped', () => {
		// The failure `workerd` hides: a throw in `webSocketMessage` does not close
		// the socket, so without an ack a refused update simply evaporates and
		// every layer reports success.
		const { wire, hub, phone } = setup();
		phone.connect();

		const outcome = (() => {
			let refusal: unknown;
			const socket = { send: (bytes: Uint8Array) => (refusal = bytes) };
			const connection: HubConnection = { cursor: 0, send: socket.send };
			hub.join(connection);
			hub.receive(
				connection,
				encodeFrame({
					kind: 'push',
					submission: 7,
					chunk: 0,
					chunks: 1,
					bytes: new Uint8Array([1, 2, 3, 4, 5, 6]),
				}),
			);
			return refusal as Uint8Array;
		})();

		// The authority answered rather than going quiet.
		expect(outcome).toBeInstanceOf(Uint8Array);
		expect(outcome[0]).toBe(3);

		// And nothing was stored, so no device will ever throw on it.
		wire.settle();
		expect(phone.titles()).toEqual([]);
	});

	test('a replica that never hears an ack still owes the work after reconnecting', () => {
		const { wire, phone, laptop } = setup();
		laptop.connect();
		phone.connect();
		expectOk(phone.db.notes.create({ title: 'Groceries' }));
		phone.client.flush();
		expect(phone.client.status().inFlight).toBe(true);

		// The socket dies with the push in flight and the ack never written.
		phone.disconnect();
		wire.settle();

		phone.connect();
		wire.settle();

		expect(laptop.titles()).toEqual(['Groceries']);
		expect(phone.client.status().owed).toBe(0);
	});
});

describe('the log grows with sends rather than with transactions', () => {
	test('twenty transactions coalesce into one entry', () => {
		const { wire, authority, phone, laptop } = setup();
		phone.connect();
		laptop.connect();

		for (let index = 0; index < 20; index += 1) {
			expectOk(phone.db.notes.create({ title: `note ${index}` }));
			// Every transaction nudges, as a real caller would. The idle timer is
			// what collapses them, not the caller being careful.
			phone.client.nudge();
		}
		wire.settle();

		expect(expectOk(authority.head())).toBe(1);
		expect(laptop.titles()).toHaveLength(20);
	});

	test('CONTROL: flushing each one instead produces twenty entries', () => {
		// Without this the test above passes for a client that silently drops
		// nineteen transactions, which looks identical from the authority's side.
		const { wire, authority, phone, laptop } = setup();
		phone.connect();
		laptop.connect();

		for (let index = 0; index < 20; index += 1) {
			expectOk(phone.db.notes.create({ title: `note ${index}` }));
			phone.client.flush();
			wire.settle();
		}

		expect(expectOk(authority.head())).toBe(20);
		expect(laptop.titles()).toHaveLength(20);
	});
});

describe('chunking is framing, and carries what no single frame could', () => {
	test('an update past the storage cap survives the round trip', () => {
		const { wire, phone, laptop } = setup();
		phone.connect();
		laptop.connect();
		const note = expectOk(phone.db.notes.create({ title: 'a big paste' }));
		const text = phone.db.notes.document(note.id)?.get('editor', 'text');
		if (text === undefined) throw new Error('the row has no document');
		// One transaction, well past 2,097,152 bytes. There is no seam here for a
		// coalescing bound to cut at, which is why the fix is framing at storage.
		text.applyDelta(text.change.insert('x'.repeat(3_000_000)) as never);
		phone.client.flush();
		wire.settle();

		const arrived = laptop.db.notes.document(note.id)?.get('editor', 'text');
		expect(arrived?.length).toBe(3_000_000);
		expect(laptop.titles()).toEqual(['a big paste']);
		expect(laptop.client.status().unresolvedDependencies).toBe(false);
	});

	test('CONTROL: it really was chunked, and one chunk alone is not an update', () => {
		// If the update had fit in one frame the test above would prove nothing
		// about reassembly. This asserts the split happened AND that a lone piece
		// is independently worthless, so concatenation is doing real work.
		const doc = new Y.Doc({ gc: true });
		const text = doc.get('editor', 'text');
		doc.transact(() => text.applyDelta(text.change.insert('x'.repeat(5_000_000)) as never));
		const bytes = new Uint8Array(Y.encodeStateAsUpdateV2(doc));
		const chunks = intoChunks(bytes);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			const replica = new Y.Doc({ gc: true });
			expect(() =>
				Y.applyUpdateV2(replica, new Uint8Array(chunk) as Uint8Array<ArrayBuffer>),
			).toThrow();
			replica.destroy();
		}
		doc.destroy();
	});
});

describe('the cursor is contiguous, and a jump is refused rather than absorbed', () => {
	test('an entry that skips a position is not applied and moves nothing', () => {
		const { wire, phone } = setup();
		phone.connect();
		wire.settle();
		const before = phone.client.status().cursor;

		const skipped = phone.client.receive(
			encodeFrame({
				kind: 'entry',
				seq: before + 5,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array([0]),
			}),
		);

		expect(skipped.error?.name).toBe('Gap');
		expect(phone.client.status().cursor).toBe(before);
	});

	test('CONTROL: the very next position IS applied, so the check is not refusing everything', () => {
		const { wire, phone, laptop } = setup();
		phone.connect();
		laptop.connect();
		expectOk(phone.db.notes.create({ title: 'Groceries' }));
		phone.client.flush();
		wire.settle();

		expect(laptop.client.status().cursor).toBe(1);
		expect(laptop.titles()).toEqual(['Groceries']);
	});
});

describe('sustained traffic through one authority', () => {
	test('a thousand sends stay contiguous and converge', () => {
		const { wire, authority, phone, laptop } = setup();
		phone.connect();
		laptop.connect();

		for (let index = 0; index < 500; index += 1) {
			expectOk(phone.db.notes.create({ title: `phone ${index}` }));
			phone.client.flush();
			expectOk(laptop.db.notes.create({ title: `laptop ${index}` }));
			laptop.client.flush();
			wire.settle();
		}

		expect(expectOk(authority.head())).toBe(1000);
		expect(phone.titles()).toHaveLength(1000);
		expect(laptop.titles()).toEqual(phone.titles());
		expect(phone.client.status().cursor).toBe(1000);
		expect(laptop.client.status().cursor).toBe(1000);
		expect(phone.client.status().lastError).toBeUndefined();
		expect(laptop.client.status().lastError).toBeUndefined();
	});
});

