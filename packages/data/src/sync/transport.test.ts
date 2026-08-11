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

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { defineLens, type LensJson } from '@epicenter/lens';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import type { Result } from 'wellcrafted/result';

import {
	createReplicaStore,
	type LensView,
	type TableHandle,
} from '../store/store.js';
import {
	AuthorityError,
	openSyncAuthority,
	type SyncAuthority,
} from './authority.js';
import { createSyncClient } from './client.js';
import {
	createChunkCollector,
	decodeFrame,
	encodeFrame,
	intoChunks,
} from './frames.js';
import { createSyncHub, type HubConnection } from './hub.js';

const lens = defineLens({
	namespace: 'so.epicenter.honeycrisp',
	tables: { notes: { title: 'string' } },
});

function expectOk<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (result.error !== null) throw result.error;
	return result.data as TValue;
}

/**
 * One table on an untyped binding.
 *
 * An untyped view holds a record of tables, so every one reads as possibly
 * absent. Where a
 * test is about a lens NOT declaring a table it looks for that `undefined`
 * deliberately; everywhere else the lens declares it, and this says so once.
 */
function tableOf(
	view: { tables: Readonly<Record<string, TableHandle>> },
	name: string,
): TableHandle {
	const handle = view.tables[name];
	if (handle === undefined) throw new Error(`this lens declares no '${name}'`);
	return handle;
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
		/**
		 * Deliver `count` messages and leave the rest queued.
		 *
		 * How a socket that dies part way through a chunked transfer is modelled:
		 * the frames ahead of the break land, and the ones behind it are still in
		 * the queue when the close discards them. Without this the only reachable
		 * schedules are "everything arrived" and "nothing did", and a partial
		 * transfer is neither.
		 */
		step(count = 1) {
			for (let index = 0; index < count && queue.length > 0; index += 1) {
				(queue.shift() as () => void)();
			}
		},
		inFlight: () => queue.length,
	};
}

type Wire = ReturnType<typeof createWire>;

function openReplica(
	label: string,
	hub: ReturnType<typeof createSyncHub>,
	wire: Wire,
	/**
	 * The lens this device is running, which is not always the same one.
	 *
	 * A device updates before another device does, so two replicas of one
	 * partition routinely hold lenses that disagree. Everything here declares
	 * `notes.title`, which is what keeps `titles()` meaningful across all of them.
	 */
	through: LensJson = lens,
) {
	const database = createBunSqliteAdapter(new Database(':memory:'));
	const store = createReplicaStore({ database });
	// One binding, two views of it: the typed view costs nothing and is honest
	// for every replica running the default lens; a replica running another one
	// reads through `bound`.
	const bound = expectOk(store.bind(through));
	const db = bound as unknown as LensView<typeof lens>;
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
	// A socket generation, so a close discards whatever was queued for it. The
	// first version of this harness delivered those frames anyway, which no real
	// socket does, and it manufactured out-of-order deliveries that cannot happen.
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
		bound,
		client,
		connection,
		socket,
		connect() {
			connection.cursor = client.cursor();
			// Tests sometimes seed the durable identity after creating the client.
			// A real client reads it when it is constructed; use the durable value
			// here so the simulated connection has the same declared identity.
			connection.document = expectOk(store.sync.documentIdentity());
			const admission = hub.join(connection);
			client.attach(socket);
			if (admission === 'bootstrap') {
				// Bootstrap carries bytes but never membership. A real authority
				// closes here and the driver dials again; this synchronous harness
				// delivers the bootstrap then performs that second dial directly.
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
			expectOk(db.tables.notes.list())
				.rows.map((row) => row.title)
				.sort(),
	};
}

function openAuthority(snapshotFloorBytes?: number) {
	const database = createBunSqliteAdapter(new Database(':memory:'));
	const authority = openSyncAuthority({ database, snapshotFloorBytes });
	return { authority, hub: createSyncHub({ authority, batch: 8 }) };
}

function setup(snapshotFloorBytes?: number) {
	const wire = createWire();
	const { authority, hub } = openAuthority(snapshotFloorBytes);
	const phone = openReplica('phone', hub, wire);
	const laptop = openReplica('laptop', hub, wire);
	return { wire, authority, hub, phone, laptop };
}

/** A floor low enough that ordinary test traffic reaches the snapshot path. */
const TINY_FLOOR = 512;

describe('two replicas converge through a log of opaque bytes', () => {
	test('a row created on one device arrives on the other', () => {
		const { wire, phone, laptop } = setup();
		phone.connect();
		laptop.connect();

		expectOk(phone.db.tables.notes.create({ title: 'Groceries' }));
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

		expectOk(phone.db.tables.notes.create({ title: 'Groceries' }));
		phone.client.flush();
		// wire.settle() deliberately omitted.

		expect(laptop.titles()).toEqual([]);
	});

	test('edits made on both devices while connected merge', () => {
		const { wire, phone, laptop } = setup();
		phone.connect();
		laptop.connect();

		expectOk(phone.db.tables.notes.create({ title: 'from the phone' }));
		expectOk(laptop.db.tables.notes.create({ title: 'from the laptop' }));
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
			expectOk(phone.db.tables.notes.create({ title: `note ${index}` }));
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

	test('workspace work authored before bootstrap is discarded instead of merged', () => {
		const { wire, authority, phone, laptop } = setup();
		laptop.connect();

		// The phone never connects while it writes.
		expectOk(phone.db.tables.notes.create({ title: 'written on a plane' }));
		expectOk(phone.db.tables.notes.create({ title: 'also on a plane' }));
		phone.client.flush();
		wire.settle();
		expect(laptop.titles()).toEqual([]);

		phone.connect();
		wire.settle();

		// A pre-bootstrap document has no authority identity. It is not an
		// offline workspace replica, so it never joins or republishes its bytes.
		expect(phone.client.status().superseded).toBe(true);
		expect(laptop.titles()).toEqual([]);
		expect(expectOk(authority.head())).toBe(0);
	});

	test('a deletion replicates, which a state vector could never have told us', () => {
		const { wire, phone, laptop } = setup();
		phone.connect();
		laptop.connect();
		const note = expectOk(phone.db.tables.notes.create({ title: 'Groceries' }));
		phone.client.flush();
		wire.settle();
		expect(laptop.titles()).toEqual(['Groceries']);

		expectOk(phone.db.tables.notes.delete(note.id));
		phone.client.flush();
		wire.settle();

		expect(laptop.titles()).toEqual([]);
	});

	test('prose written into a row document replicates with the row', () => {
		const { wire, phone, laptop } = setup();
		phone.connect();
		laptop.connect();
		const note = expectOk(phone.db.tables.notes.create({ title: 'Groceries' }));
		const text = phone.db.tables.notes.document(note.id)?.get('editor', 'text');
		if (text === undefined) throw new Error('the row has no document');
		text.applyDelta(text.change.insert('buy milk') as never);
		phone.client.flush();
		wire.settle();

		const arrived = laptop.db.tables.notes
			.document(note.id)
			?.get('editor', 'text');
		expect(arrived?.length).toBe('buy milk'.length);
	});
});

describe('the ack is what makes a refusal visible', () => {
	test('an update is owed until the authority names its position', () => {
		const { wire, phone, laptop } = setup();
		phone.connect();
		laptop.connect();
		// Let the document announcements land, so the first flush can stamp
		// and send rather than holding the work for the greeting.
		wire.settle();
		expectOk(phone.db.tables.notes.create({ title: 'Groceries' }));
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
		// the socket, so without an answer a refused update simply evaporates and
		// every layer reports success.
		//
		// The refusal exercised here is a framing violation, which is the only kind
		// left. The authority never reads the bytes, so "this is not a valid
		// update" is not a sentence anything on the server can say; what the
		// collector still knows is how many chunks it was promised.
		const { wire, authority, hub, phone } = setup();
		phone.connect();

		const answers: Uint8Array[] = [];
		const connection: HubConnection = {
			cursor: 0,
			document: expectOk(authority.document()),
			send: (bytes) => answers.push(bytes),
		};
		hub.join(connection);
		// Chunk 0 opens submission 7 as three chunks long. Chunk 1 arrives claiming
		// the same submission is two, so the collector no longer knows when it is
		// whole and drops what it was holding.
		hub.receive(
			connection,
			encodeFrame({
				kind: 'push',
				submission: 7,
				chunk: 0,
				chunks: 3,
				bytes: new Uint8Array([1, 2, 3]),
			}),
		);
		hub.receive(
			connection,
			encodeFrame({
				kind: 'push',
				submission: 7,
				chunk: 1,
				chunks: 2,
				bytes: new Uint8Array([4, 5, 6]),
			}),
		);

		// The authority answered rather than going quiet, and it named the
		// submission, so the client knows exactly which work it still owes.
		// (The first frame is the document announcement every join begins with.)
		expect(answers).toHaveLength(2);
		const refusal = expectOk(decodeFrame(answers[1] as Uint8Array));
		if (refusal.kind !== 'refuse')
			throw new Error(`answered with ${refusal.kind}`);
		expect(refusal.submission).toBe(7);

		// And nothing was stored, so no device will ever be handed a fragment.
		wire.settle();
		expect(expectOk(authority.head())).toBe(0);
		expect(phone.titles()).toEqual([]);
	});

	test('a replica that never hears an ack still owes the work after reconnecting', () => {
		const { wire, phone, laptop } = setup();
		laptop.connect();
		phone.connect();
		wire.settle();
		expectOk(phone.db.tables.notes.create({ title: 'Groceries' }));
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
			expectOk(phone.db.tables.notes.create({ title: `note ${index}` }));
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
			expectOk(phone.db.tables.notes.create({ title: `note ${index}` }));
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
		const note = expectOk(
			phone.db.tables.notes.create({ title: 'a big paste' }),
		);
		const text = phone.db.tables.notes.document(note.id)?.get('editor', 'text');
		if (text === undefined) throw new Error('the row has no document');
		// One transaction, well past 2,097,152 bytes. There is no seam here for a
		// coalescing bound to cut at, which is why the fix is framing at storage.
		text.applyDelta(text.change.insert('x'.repeat(3_000_000)) as never);
		phone.client.flush();
		wire.settle();

		const arrived = laptop.db.tables.notes
			.document(note.id)
			?.get('editor', 'text');
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
		doc.transact(() =>
			text.applyDelta(text.change.insert('x'.repeat(5_000_000)) as never),
		);
		const bytes = new Uint8Array(Y.encodeStateAsUpdateV2(doc));
		const chunks = intoChunks(bytes);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			const replica = new Y.Doc({ gc: true });
			expect(() =>
				Y.applyUpdateV2(
					replica,
					new Uint8Array(chunk) as Uint8Array<ArrayBuffer>,
				),
			).toThrow();
			replica.destroy();
		}
		doc.destroy();
	});
});

describe('a socket that dies part way through a chunked transfer', () => {
	test('a push that lost its second chunk arrives whole after reconnecting', () => {
		// The claim the in-memory collector rests on, from the client's side: a
		// partial nobody ever acked is one the client still owes. The outbox is
		// cleared by the ack and by nothing else, so this is what stands between a
		// dropped socket and a paste that no device ever sees again.
		const { wire, authority, phone, laptop } = setup();
		phone.connect();
		laptop.connect();
		const note = expectOk(
			phone.db.tables.notes.create({ title: 'a big paste' }),
		);
		const text = phone.db.tables.notes.document(note.id)?.get('editor', 'text');
		if (text === undefined) throw new Error('the row has no document');
		text.applyDelta(text.change.insert('x'.repeat(3_000_000)) as never);
		phone.client.flush();

		// It really was chunked: one frame would be one message on the wire.
		expect(wire.inFlight()).toBeGreaterThan(1);
		wire.step();
		// The hub is holding chunk 0 and has stored nothing, which is the whole
		// point of reassembling before appending: a truncated entry in the log is
		// the poison pill this design spends real effort to make impossible.
		expect(expectOk(authority.head())).toBe(0);

		phone.disconnect();
		wire.settle();
		expect(expectOk(authority.head())).toBe(0);
		expect(laptop.titles()).toEqual([]);

		phone.connect();
		wire.settle();

		expect(laptop.titles()).toEqual(['a big paste']);
		const arrived = laptop.db.tables.notes
			.document(note.id)
			?.get('editor', 'text');
		expect(arrived?.length).toBe(3_000_000);
		expect(phone.client.status().owed).toBe(0);
	});

	test('CONTROL: without the reconnect the work is nowhere, on any side', () => {
		// Without this the test above passes for a hub that stored the fragment, or
		// for a laptop that had somehow seen the paste already. Nothing recovers a
		// half-delivered submission except the client re-offering it.
		const { wire, authority, phone, laptop } = setup();
		phone.connect();
		laptop.connect();
		const note = expectOk(
			phone.db.tables.notes.create({ title: 'a big paste' }),
		);
		const text = phone.db.tables.notes.document(note.id)?.get('editor', 'text');
		if (text === undefined) throw new Error('the row has no document');
		text.applyDelta(text.change.insert('x'.repeat(3_000_000)) as never);
		phone.client.flush();
		wire.step();
		phone.disconnect();
		wire.settle();

		expect(expectOk(authority.head())).toBe(0);
		expect(laptop.titles()).toEqual([]);
		expect(laptop.db.tables.notes.document(note.id)).toBeUndefined();
		// And the phone still owes it, which is what the reconnect above spends.
		expect(phone.client.status().owed).toBeGreaterThan(0);
	});

	test('a partial submission does not survive the connection that opened it', () => {
		// The other half of "lost to eviction is safe": the authority must not
		// staple a returning client's chunks onto a stranger's fragment. Each
		// connection gets its own collector and `leave` drops it, so a submission
		// number is only ever meaningful within one socket.
		const { authority, hub } = openAuthority();
		const answers: Uint8Array[] = [];
		const first: HubConnection = {
			cursor: 0,
			document: expectOk(authority.document()),
			send: (bytes) => answers.push(bytes),
		};
		hub.join(first);
		hub.receive(
			first,
			encodeFrame({
				kind: 'push',
				submission: 7,
				chunk: 0,
				chunks: 2,
				bytes: new Uint8Array([1, 2, 3]),
			}),
		);
		hub.leave(first);

		// A second socket sends what the first one had left: the tail of submission
		// 7. It completes nothing, because there is nothing here to complete.
		const second: HubConnection = {
			cursor: 0,
			document: expectOk(authority.document()),
			send: (bytes) => answers.push(bytes),
		};
		hub.join(second);
		answers.length = 0;
		hub.receive(
			second,
			encodeFrame({
				kind: 'push',
				submission: 7,
				chunk: 1,
				chunks: 2,
				bytes: new Uint8Array([4, 5, 6]),
			}),
		);

		expect(expectOk(authority.head())).toBe(0);
		expect(answers).toEqual([]);
	});

	test('CONTROL: the same two chunks on one connection DO complete it', () => {
		// Without this the test above passes for a hub that ignores every push.
		const { authority, hub } = openAuthority();
		const answers: Uint8Array[] = [];
		const only: HubConnection = {
			cursor: 0,
			document: expectOk(authority.document()),
			send: (bytes) => answers.push(bytes),
		};
		hub.join(only);
		for (const [chunk, bytes] of [
			[0, new Uint8Array([1, 2, 3])],
			[1, new Uint8Array([4, 5, 6])],
		] as const) {
			hub.receive(
				only,
				encodeFrame({ kind: 'push', submission: 7, chunk, chunks: 2, bytes }),
			);
		}

		expect(expectOk(authority.head())).toBe(1);
		expect(expectOk(authority.since(0))[0]?.bytes).toEqual(
			new Uint8Array([1, 2, 3, 4, 5, 6]),
		);
	});

	test('a replica that loses a snapshot mid-transfer converges on reconnect', () => {
		// The authority's side of the same failure. This replica can only be served
		// by the snapshot, because the entries it covers are deleted, so a snapshot
		// that dies in flight and is not retried is a device that never syncs again.
		const { wire, authority, phone, laptop } = setup();
		phone.connect();
		const note = expectOk(
			phone.db.tables.notes.create({ title: 'a big paste' }),
		);
		const text = phone.db.tables.notes.document(note.id)?.get('editor', 'text');
		if (text === undefined) throw new Error('the row has no document');
		text.applyDelta(text.change.insert('x'.repeat(3_000_000)) as never);
		phone.client.flush();
		wire.settle();
		// The snapshot is not staged by hand here: a 3 MB paste is past the floor on
		// its own, so the hub asked the phone for one and the tail is already gone.
		expect(expectOk(authority.snapshotPosition())).toBe(1);
		expect(expectOk(authority.since(0, 1_000))).toEqual([]);

		expectOk(
			laptop.store.sync.adoptDocumentIdentity(expectOk(authority.document())),
		);
		laptop.connect();
		expect(wire.inFlight()).toBeGreaterThan(1);
		wire.step();
		laptop.disconnect();
		wire.settle();

		// One chunk of a snapshot is not state, and the replica knows it holds
		// nothing rather than believing it is caught up.
		expect(laptop.titles()).toEqual([]);
		expect(laptop.client.status().cursor).toBe(0);

		laptop.connect();
		wire.settle();

		expect(laptop.titles()).toEqual(['a big paste']);
		const arrived = laptop.db.tables.notes
			.document(note.id)
			?.get('editor', 'text');
		expect(arrived?.length).toBe(3_000_000);
		expect(laptop.client.status().cursor).toBe(1);
		expect(laptop.client.status().unresolvedDependencies).toBe(false);
	});
});

/**
 * The collector on its own, fed real update bytes cut small.
 *
 * Driven directly rather than through the client, because everything here is
 * about chunk arithmetic and reaching it through the transport would mean
 * multi-megabyte payloads per case. The BYTES are real and the reassembled
 * result is applied to a real replica and read back through its lens, so what is
 * synthetic is the chunk size and nothing else.
 */
describe('reassembly holds partials in memory, and only in memory', () => {
	/** One replica's whole state, cut into more chunks than any case needs. */
	function cutUpdate(source: ReturnType<typeof openReplica>, limit = 16) {
		const bytes = source.store.encodeStateSince();
		const chunks = intoChunks(bytes, limit);
		if (chunks.length < 4) throw new Error(`only ${chunks.length} chunks`);
		return { bytes, chunks };
	}

	function push(chunks: Uint8Array[], chunk: number) {
		return {
			kind: 'push' as const,
			submission: 7,
			chunk,
			chunks: chunks.length,
			bytes: chunks[chunk] as Uint8Array,
		};
	}

	test('chunks that arrive out of order reassemble into the update they were cut from', () => {
		const { phone, laptop } = setup();
		expectOk(phone.db.tables.notes.create({ title: 'Groceries' }));
		const { bytes, chunks } = cutUpdate(phone);
		const collector = createChunkCollector({ limitBytes: 1 << 20 });

		let whole: Uint8Array | undefined;
		// Backwards, so the last chunk arrives first and chunk 0 arrives last.
		for (const index of [...chunks.keys()].reverse()) {
			whole = expectOk(collector.accept(push(chunks, index)));
			// Complete only once every index has landed, never before.
			expect(whole === undefined).toBe(index !== 0);
		}

		expect(whole).toEqual(bytes);
		expect(collector.bufferedBytes()).toBe(0);
		// Byte equality alone would not show the update still works, so it is
		// applied to a replica that has never seen this row and read back through
		// that replica's own lens.
		expectOk(laptop.store.applyRemote(whole as Uint8Array));
		expect(laptop.titles()).toEqual(['Groceries']);
	});

	test('CONTROL: one chunk short is never whole, and the replica stays empty', () => {
		// Without this, "out of order still reassembles" would pass for a collector
		// that hands back whatever it holds on the first frame.
		const { phone, laptop } = setup();
		expectOk(phone.db.tables.notes.create({ title: 'Groceries' }));
		const { chunks } = cutUpdate(phone);
		const collector = createChunkCollector({ limitBytes: 1 << 20 });

		for (const index of [...chunks.keys()].reverse()) {
			if (index === 1) continue;
			expect(expectOk(collector.accept(push(chunks, index)))).toBeUndefined();
		}

		expect(collector.bufferedBytes()).toBeGreaterThan(0);
		expect(laptop.titles()).toEqual([]);
	});

	test('a chunk that arrives twice does not count twice', () => {
		// Re-delivery is ordinary here: a reconnect re-sends a submission from its
		// first chunk, so a collector that counted frames rather than filled slots
		// would call a submission whole while a hole was still in it.
		const { phone, laptop } = setup();
		expectOk(phone.db.tables.notes.create({ title: 'Groceries' }));
		const { bytes, chunks } = cutUpdate(phone);
		const collector = createChunkCollector({ limitBytes: 1 << 20 });

		const repeated = [0, 0, 0, ...chunks.keys()];
		let whole: Uint8Array | undefined;
		for (const index of repeated) {
			whole = expectOk(collector.accept(push(chunks, index)));
			expect(whole === undefined).toBe(index !== chunks.length - 1);
		}

		expect(whole).toEqual(bytes);
		expect(collector.bufferedBytes()).toBe(0);
		expectOk(laptop.store.applyRemote(whole as Uint8Array));
		expect(laptop.titles()).toEqual(['Groceries']);
	});

	test('CONTROL: repeats alone never fill the holes they duplicate', () => {
		const { phone, laptop } = setup();
		expectOk(phone.db.tables.notes.create({ title: 'Groceries' }));
		const { chunks } = cutUpdate(phone);
		const collector = createChunkCollector({ limitBytes: 1 << 20 });

		for (const index of [0, 0, 0, 0, 1, 1, 1]) {
			expect(expectOk(collector.accept(push(chunks, index)))).toBeUndefined();
		}

		// Two slots filled and the rest empty, however many frames arrived.
		expect(collector.bufferedBytes()).toBe(
			(chunks[0]?.length ?? 0) + (chunks[1]?.length ?? 0),
		);
		expect(laptop.titles()).toEqual([]);
	});

	test('a partial nobody finishes is held until something forgets it', () => {
		// Nothing ages a partial out, and that is deliberate rather than an
		// oversight: eviction on a timer would drop a submission a slow client is
		// still sending. The bound is the byte limit, and the release is the
		// collector itself going away with the connection that owned it.
		const collector = createChunkCollector({ limitBytes: 1 << 20 });
		expectOk(
			collector.accept({
				kind: 'push',
				submission: 7,
				chunk: 0,
				chunks: 3,
				bytes: new Uint8Array(600),
			}),
		);
		expect(collector.bufferedBytes()).toBe(600);

		// Other traffic completing does not release it, so a dead submission is not
		// swept up by a live one.
		expectOk(
			collector.accept({
				kind: 'push',
				submission: 8,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array(9),
			}),
		);
		expect(collector.bufferedBytes()).toBe(600);

		collector.forget(7);
		expect(collector.bufferedBytes()).toBe(0);
	});

	test('past the limit the partial is dropped and the sender is told', () => {
		// The ceiling that makes "held in memory" bounded rather than a promise. A
		// client that opens submissions and never finishes them is asking the
		// authority to hold bytes forever, and the answer is a refusal it can act
		// on, because it still owes the work.
		const collector = createChunkCollector({ limitBytes: 1_000 });
		expectOk(
			collector.accept({
				kind: 'push',
				submission: 7,
				chunk: 0,
				chunks: 3,
				bytes: new Uint8Array(600),
			}),
		);
		const over = collector.accept({
			kind: 'push',
			submission: 7,
			chunk: 1,
			chunks: 3,
			bytes: new Uint8Array(600),
		});

		expect(over.error?.name).toBe('Malformed');
		expect(collector.bufferedBytes()).toBe(0);
	});
});

describe('a partial that outlives the socket that opened it', () => {
	/**
	 * The client keeps ONE collector for the life of the client, and `detach`
	 * does not clear it. Positions in it are entry sequence numbers and snapshot
	 * positions in the same key space, so a partial left behind by a dead socket
	 * is waiting for whatever the authority sends at that number next.
	 *
	 * The hub does not have this problem: a collector belongs to a connection and
	 * `leave` drops it, which is pinned above by 'a partial submission does not
	 * survive the connection that opened it'.
	 */
	function stallMidEntry() {
		// A floor nothing reaches, so both snapshots here are staged deliberately
		// and the sizes are the real ones the transport would produce.
		const { wire, authority, phone, laptop } = setup(Number.MAX_SAFE_INTEGER);
		phone.connect();
		const note = expectOk(
			phone.db.tables.notes.create({ title: 'a big paste' }),
		);
		const text = phone.db.tables.notes.document(note.id)?.get('editor', 'text');
		if (text === undefined) throw new Error('the row has no document');
		text.applyDelta(text.change.insert('x'.repeat(4_000_000)) as never);
		phone.client.flush();
		wire.settle();
		expectOk(authority.replaceSnapshot(1, phone.store.encodeStateSince()));
		const first = expectOk(authority.snapshot());
		const snapshotChunks = intoChunks(first?.bytes as Uint8Array).length;
		// This test needs to control the first snapshot frame. Give the empty
		// replica the current identity before it connects so it enters the normal
		// equality path rather than completing bootstrap synchronously in the
		// harness.
		expectOk(
			laptop.store.sync.adoptDocumentIdentity(expectOk(authority.document())),
		);

		// Entry 2 is a second paste: two chunks, where the state through 2 is four.
		// That difference is the whole scenario, and it is what a delta and a whole
		// state at the same position ordinarily look like.
		text.applyDelta(text.change.insert('y'.repeat(3_000_000)) as never);
		phone.client.flush();
		wire.settle();
		expect(
			intoChunks(expectOk(authority.since(1))[0]?.bytes as Uint8Array),
		).toHaveLength(2);

		return { wire, authority, phone, laptop, note, snapshotChunks };
	}

	function readProse(replica: ReturnType<typeof openReplica>, rowId: string) {
		return replica.db.tables.notes.document(rowId)?.get('editor', 'text')
			.length;
	}

	test('a snapshot cut differently to the entry it replaces still arrives', () => {
		const { wire, authority, phone, laptop, note, snapshotChunks } =
			stallMidEntry();

		// The laptop takes the snapshot at 1, then the first chunk of entry 2, and
		// its socket dies. It is now holding a partial at position 2, two chunks
		// wide, that will never be completed by anything.
		laptop.connect();
		wire.step(snapshotChunks + 1);
		laptop.disconnect();
		wire.settle();
		expect(laptop.client.status().cursor).toBe(1);
		expect(readProse(laptop, note.id)).toBe(4_000_000);

		// The authority snapshots at 2 and the tail it covers is gone, so the
		// snapshot is now the only way this replica can ever converge.
		expectOk(authority.replaceSnapshot(2, phone.store.encodeStateSince()));
		expect(expectOk(authority.since(0, 1_000))).toEqual([]);
		expect(
			intoChunks(expectOk(authority.snapshot())?.bytes as Uint8Array),
		).toHaveLength(4);

		laptop.connect();
		wire.settle();

		// This used to leave the replica at 4,000,000 in silence. A partial from
		// the dead socket sat at position 2, a four-chunk snapshot arrived at the
		// same position, the collector reported a framing error, and
		// `client.receive` mapped it to `Ok(undefined)`: chunk 0 discarded, the
		// rest stranded in a partial that could never complete, `lastError`
		// undefined and `needsResync` false. Two changes close it. A collector
		// belongs to a socket and is rebuilt on attach and detach, so nothing
		// survives to collide; and a reassembly failure is reported rather than
		// swallowed, so even a collision that did happen asks to be reconnected.
		expect(readProse(laptop, note.id)).toBe(7_000_000);
		expect(laptop.client.status().needsResync).toBe(false);
		expect(laptop.client.status().lastError).toBeUndefined();
	});

	test('a reassembly failure asks to be reconnected instead of going quiet', () => {
		// The second half of the fix, on its own. Even if frames that contradict
		// their own count reach a replica, it must say so: a partial nothing will
		// ever complete stops the replica dead while every layer reports success.
		const { wire, phone } = setup();
		phone.connect();
		wire.settle();

		const first = phone.client.receive(
			encodeFrame({
				kind: 'entry',
				seq: 1,
				chunk: 0,
				chunks: 3,
				bytes: new Uint8Array([1]),
			}),
		);
		expect(first.error).toBeNull();
		const contradicting = phone.client.receive(
			encodeFrame({
				kind: 'entry',
				seq: 1,
				chunk: 1,
				chunks: 2,
				bytes: new Uint8Array([2]),
			}),
		);

		expect(contradicting.error?.name).toBe('BrokenStream');
		expect(phone.client.status().needsResync).toBe(true);
	});

	test('CONTROL: without the stale partial the same snapshot converges first time', () => {
		// The isolation. Same sizes, same four-chunk snapshot, same reconnect: the
		// only difference is that this laptop's socket died on a frame boundary
		// rather than inside a chunked entry.
		const { wire, authority, phone, laptop, note, snapshotChunks } =
			stallMidEntry();

		laptop.connect();
		// One extra step for the document announcement that opens every join.
		wire.step(1 + snapshotChunks);
		laptop.disconnect();
		wire.settle();
		expect(laptop.client.status().cursor).toBe(1);

		expectOk(authority.replaceSnapshot(2, phone.store.encodeStateSince()));
		laptop.connect();
		wire.settle();

		expect(readProse(laptop, note.id)).toBe(7_000_000);
		expect(laptop.client.status().cursor).toBe(2);
		expect(laptop.titles()).toEqual(['a big paste']);
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
		expectOk(phone.db.tables.notes.create({ title: 'Groceries' }));
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
			expectOk(phone.db.tables.notes.create({ title: `phone ${index}` }));
			phone.client.flush();
			expectOk(laptop.db.tables.notes.create({ title: `laptop ${index}` }));
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

describe('an entry that will not apply is loud, not silent', () => {
	test('the replica reports it, names the position, and moves nothing', () => {
		// The poison pill seen from the only place it is ever visible. This
		// returned Ok and set no error, so a bricked device looked exactly like an
		// idle one: it stopped syncing and every layer reported success. Nothing
		// recovers a failure nobody is told about.
		const { wire, phone } = setup();
		phone.connect();
		wire.settle();
		const before = phone.client.status().cursor;

		const outcome = phone.client.receive(
			encodeFrame({
				kind: 'entry',
				seq: before + 1,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array([1, 2, 3, 4, 5, 6]),
			}),
		);

		expect(outcome.error?.name).toBe('Unapplyable');
		expect((outcome.error as { seq?: number } | null)?.seq).toBe(before + 1);
		expect(phone.client.status().lastError?.name).toBe('Unapplyable');
		// Stuck, deliberately: advancing past it would trade a visible stall for
		// permanent invisible loss.
		expect(phone.client.status().cursor).toBe(before);
	});

	test('the authority stores bytes it cannot read, and only the reader finds out', () => {
		// The whole server half of this story, end to end. The authority used to
		// decode every update and refuse what threw; that check was never a proof
		// (it let 44 of ~5,900 single-byte corruptions through), cost more than
		// hydrating an entire document, and reading the bytes at all is what would
		// make end-to-end encryption impossible. So garbage is accepted, given a
		// position, and relayed. Nothing on the server has an opinion about it, and
		// the replica that cannot apply it is the one that says so.
		const { wire, authority, hub, phone } = setup();
		phone.connect();
		wire.settle();

		const answers: Uint8Array[] = [];
		const writer: HubConnection = {
			cursor: 0,
			document: expectOk(authority.document()),
			send: (bytes) => answers.push(bytes),
		};
		hub.join(writer);
		hub.receive(
			writer,
			encodeFrame({
				kind: 'push',
				submission: 7,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array([1, 2, 3, 4, 5, 6]),
			}),
		);

		// Accepted: acknowledged at a position, and in the log byte for byte.
		// (The first frame is the document announcement every join begins with.)
		const answer = expectOk(decodeFrame(answers[1] as Uint8Array));
		if (answer.kind !== 'ack') throw new Error(`answered with ${answer.kind}`);
		expect(answer.seq).toBe(1);
		expect(expectOk(authority.head())).toBe(1);
		expect(expectOk(authority.since(0))[0]?.bytes).toEqual(
			new Uint8Array([1, 2, 3, 4, 5, 6]),
		);

		// And the failure surfaces where the bytes are finally read, naming the
		// position an operator has to neutralise.
		wire.settle();
		const stuck = phone.client.status().lastError;
		expect(stuck?.name).toBe('Unapplyable');
		expect((stuck as { seq?: number } | undefined)?.seq).toBe(1);
		expect(phone.client.status().cursor).toBe(0);
	});

	test('CONTROL: a good entry at the same position applies and reports nothing', () => {
		const { wire, phone, laptop } = setup();
		phone.connect();
		laptop.connect();
		expectOk(laptop.db.tables.notes.create({ title: 'Groceries' }));
		laptop.client.flush();
		wire.settle();

		expect(phone.client.status().lastError).toBeUndefined();
		expect(phone.titles()).toEqual(['Groceries']);
	});

	test('neutralising the position in the log unsticks the replica', () => {
		// Why no server-side check is needed to RECOVER from a poison pill. The
		// log is append-only and every entry is individually addressable, so the
		// repair is to overwrite one row with the 13-byte empty update, which is
		// a valid no-op. The sequence stays contiguous and every replica walks
		// straight past it.
		const { wire, phone, laptop } = setup();
		phone.connect();
		laptop.connect();
		expectOk(laptop.db.tables.notes.create({ title: 'Groceries' }));
		laptop.client.flush();
		wire.settle();

		const noop = new Uint8Array(
			Y.encodeStateAsUpdateV2(new Y.Doc({ gc: true })),
		);
		expect(noop.length).toBe(13);
		const stuck = phone.client.receive(
			encodeFrame({
				kind: 'entry',
				seq: 2,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array([9, 9, 9]),
			}),
		);
		expect(stuck.error?.name).toBe('Unapplyable');

		// The operator replaces entry 2's bytes. The replica takes it and moves on.
		expectOk(
			phone.client.receive(
				encodeFrame({
					kind: 'entry',
					seq: 2,
					chunk: 0,
					chunks: 1,
					bytes: noop,
				}),
			),
		);

		expect(phone.client.status().cursor).toBe(2);
		expect(phone.titles()).toEqual(['Groceries']);
	});
});

describe('the authority keeps a snapshot and a tail, not a log', () => {
	test('a snapshot replaces the entries it covers, and storage stops growing', () => {
		const { wire, authority, phone, laptop } = setup();
		phone.connect();
		laptop.connect();
		for (let index = 0; index < 30; index += 1) {
			expectOk(phone.db.tables.notes.create({ title: `note ${index}` }));
			phone.client.flush();
			wire.settle();
		}
		const head = expectOk(authority.head());
		const before = expectOk(authority.since(0, 1_000)).length;
		expect(before).toBe(30);

		// Driven directly rather than by the floor, which a thirty-note document
		// never reaches. What is under test is what a snapshot DOES, not when the
		// authority decides to ask for one.
		expectOk(authority.replaceSnapshot(head, phone.store.encodeStateSince()));

		expect(expectOk(authority.snapshotPosition())).toBe(head);
		expect(expectOk(authority.since(0, 1_000))).toEqual([]);
		expect(laptop.titles()).toHaveLength(30);
	});

	test('a previously bootstrapped replica behind the snapshot keeps same-document offline work', () => {
		// The case the whole shape exists for. The tail this replica needed is
		// gone, so it can only be served by the snapshot, and it is carrying work
		// nobody has seen.
		const { wire, authority, phone, laptop } = setup();
		phone.connect();
		laptop.connect();
		laptop.disconnect();
		for (let index = 0; index < 30; index += 1) {
			expectOk(phone.db.tables.notes.create({ title: `note ${index}` }));
			phone.client.flush();
			wire.settle();
		}

		// The tail is gone, so this replica can only be served by the snapshot.
		expectOk(
			authority.replaceSnapshot(
				expectOk(authority.head()),
				phone.store.encodeStateSince(),
			),
		);

		// This work is offline but not unlabelled: the replica already adopted
		// this workspace document before it went away.
		expectOk(laptop.db.tables.notes.create({ title: 'WRITTEN OFFLINE' }));
		laptop.connect();
		wire.settle();
		laptop.client.flush();
		wire.settle();

		expect(laptop.titles()).toHaveLength(31);
		expect(laptop.titles()).toContain('WRITTEN OFFLINE');
		expect(laptop.client.status().unresolvedDependencies).toBe(false);
		// And it converges both ways, so the offline note reached the other side.
		expect(phone.titles()).toEqual(laptop.titles());
	});

	test('a deleted note is not in the snapshot, so it stops being recoverable', () => {
		// The privacy consequence, and the reason this shape is worth the change.
		// A never-compacted log holds the update that CREATED a row forever
		// (`evidence/retention.test.ts`); a snapshot is current state and carries
		// no trace of it.
		const { wire, authority, phone } = setup();
		phone.connect();
		const secret = 'SECRET-CANARY-therapist';
		const note = expectOk(phone.db.tables.notes.create({ title: secret }));
		phone.client.flush();
		wire.settle();
		expectOk(phone.db.tables.notes.delete(note.id));
		phone.client.flush();
		wire.settle();
		for (let index = 0; index < 40; index += 1) {
			expectOk(phone.db.tables.notes.create({ title: `filler ${index}` }));
			phone.client.flush();
			wire.settle();
		}
		expectOk(
			authority.replaceSnapshot(
				expectOk(authority.head()),
				phone.store.encodeStateSince(),
			),
		);

		const stored = [
			...(expectOk(authority.snapshot()) === undefined
				? []
				: [expectOk(authority.snapshot())?.bytes as Uint8Array]),
			...expectOk(authority.since(0, 1_000)).map((entry) => entry.bytes),
		];
		const haystack = Buffer.concat(
			stored.map((bytes) => Buffer.from(bytes)),
		).toString('latin1');

		expect(haystack).not.toContain(secret);
		// CONTROL: a title that IS still live must be found, or the search is
		// looking in the wrong place and would pass for any string.
		expect(haystack).toContain('filler 39');
	});
});

describe('who may replace the snapshot', () => {
	test('a connection the authority has NOT sent everything to is refused', () => {
		// The half of the condition the hub owns, and the half that separates this
		// from the client-posted baseline an earlier design died on. The check is
		// against the authority's own record of what it sent, never against what
		// the replica says about itself.
		const { wire, authority, hub, phone } = setup();
		phone.connect();
		expectOk(phone.db.tables.notes.create({ title: 'real work' }));
		phone.client.flush();
		wire.settle();
		const head = expectOk(authority.head());

		const answers: Uint8Array[] = [];
		const stale: HubConnection = {
			cursor: 0,
			document: expectOk(authority.document()),
			send: (bytes) => answers.push(bytes),
		};
		hub.join(stale);
		answers.length = 0;
		// Joining catches a connection up, so the state this guard exists for has
		// to be arranged: a socket the authority has sent nothing to, claiming to
		// hold everything.
		stale.cursor = 0;
		// An empty document, offered as though it were the whole state. This is
		// the exact shape that destroyed a partition in a withdrawn design.
		hub.receive(
			stale,
			encodeFrame({
				kind: 'offer',
				position: head,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array(Y.encodeStateAsUpdateV2(new Y.Doc({ gc: true }))),
			}),
		);

		const refusal = answers.map((bytes) => expectOk(decodeFrame(bytes))).at(-1);
		expect(refusal?.kind).toBe('refuse');
		// And nothing was destroyed: the work is still there.
		expect(phone.titles()).toEqual(['real work']);
	});

	test('CONTROL: the same offer from a current connection IS accepted', () => {
		// Without this the refusal above passes for a hub that refuses every
		// offer, which would mean snapshots never happen at all.
		const { wire, authority, phone } = setup();
		phone.connect();
		for (let index = 0; index < 10; index += 1) {
			expectOk(phone.db.tables.notes.create({ title: `note ${index}` }));
			phone.client.flush();
			wire.settle();
		}

		const head = expectOk(authority.head());
		const accepted = authority.replaceSnapshot(
			head,
			phone.store.encodeStateSince(),
		);

		expect(accepted.error).toBeNull();
		expect(expectOk(authority.snapshotPosition())).toBe(head);
		expect(phone.titles()).toHaveLength(10);
	});

	test('an offer running past the end of the log is refused by the authority', () => {
		const { wire, authority, phone } = setup();
		phone.connect();
		expectOk(phone.db.tables.notes.create({ title: 'one' }));
		phone.client.flush();
		wire.settle();
		const head = expectOk(authority.head());

		// Past the end of the log: it would stand for entries nobody has written.
		const beyond = authority.replaceSnapshot(head + 5, new Uint8Array([0]));

		expect(beyond.error?.name).toBe('SnapshotRefused');
	});
});

describe('the snapshot path under sustained traffic', () => {
	test('hundreds of sends with snapshots firing throughout still converge', () => {
		// The scale that broke a live run against Cloudflare. The floor is dropped
		// so the snapshot path is reached with ordinary test traffic rather than
		// with a real vault.
		const { wire, authority, phone, laptop } = setup(TINY_FLOOR);
		phone.connect();
		laptop.connect();

		for (let index = 0; index < 300; index += 1) {
			expectOk(phone.db.tables.notes.create({ title: `note ${index}` }));
			phone.client.flush();
			wire.settle();
			expect(phone.client.status().inFlight).toBe(false);
		}

		expect(expectOk(authority.snapshotPosition())).toBeGreaterThan(0);
		expect(phone.titles()).toHaveLength(300);
		expect(laptop.titles()).toEqual(phone.titles());
		expect(phone.client.status().lastError).toBeUndefined();
		expect(laptop.client.status().lastError).toBeUndefined();
	});
});

/**
 * The same application one release later: `notes` grew a field.
 *
 * `pinned` declares no default, so it is a field the older release's rows cannot
 * satisfy. That asymmetry is the point: an extra field is invisible to a lens
 * that does not declare it, while a missing one is a row a lens cannot read, and
 * the two directions have to be told apart.
 */
const newerLens = defineLens({
	namespace: 'so.epicenter.honeycrisp',
	tables: { notes: { title: 'string', pinned: 'boolean' } },
});

/** The same application again, one release later still: a whole new table. */
const twoTableLens = defineLens({
	namespace: 'so.epicenter.honeycrisp',
	tables: { notes: { title: 'string' }, tasks: { label: 'string' } },
});

describe('two devices whose lenses disagree', () => {
	/** One partition, two devices, each running the release it was given. */
	function pair(updatedLens: LensJson) {
		const wire = createWire();
		const { authority, hub } = openAuthority();
		const updated = openReplica('updated', hub, wire, updatedLens);
		const older = openReplica('older', hub, wire);
		updated.connect();
		older.connect();
		return {
			wire,
			authority,
			hub,
			updated,
			older,
			updatedNotes: tableOf(updated.bound, 'notes'),
			olderNotes: tableOf(older.bound, 'notes'),
		};
	}

	test('a field the older release cannot name survives a round trip through it', () => {
		// The case that decides whether a release can be rolled out to one device at
		// a time. If the older release rewrote rows as its own lens sees them, every
		// edit made on the un-updated phone would silently strip the new field from
		// the updated laptop's rows.
		const { wire, updated, updatedNotes, older, olderNotes } = pair(newerLens);
		const made = expectOk(
			updatedNotes.create({ title: 'Groceries', pinned: true }),
		);
		updated.client.flush();
		wire.settle();

		// The older release sees the row, minus the one field it cannot name, and
		// reports no trouble: an undeclared key is not a conformance failure.
		const seen = expectOk(olderNotes.list());
		expect(seen.nonconforming).toEqual([]);
		expect(seen.rows).toEqual([{ id: made.id, title: 'Groceries' }]);

		expectOk(olderNotes.update(made.id, { title: 'Groceries and milk' }));
		older.client.flush();
		wire.settle();

		// Both halves in one assertion, and each is the other's control. The new
		// title proves the round trip actually happened; `pinned` proves it did not
		// cost the updated device a field the older one had never heard of.
		expect(expectOk(updatedNotes.get(made.id))).toEqual({
			id: made.id,
			title: 'Groceries and milk',
			pinned: true,
		});
	});

	test('CONTROL: the older release can still destroy the row entirely', () => {
		// Without this, "the field survived" would pass for a channel that carries
		// nothing back from the older device at all. A delete authored there has to
		// reach the updated device and take the row with it.
		const { wire, updated, updatedNotes, older, olderNotes } = pair(newerLens);
		const made = expectOk(
			updatedNotes.create({ title: 'Groceries', pinned: true }),
		);
		updated.client.flush();
		wire.settle();

		expectOk(olderNotes.delete(made.id));
		older.client.flush();
		wire.settle();

		expect(expectOk(updatedNotes.get(made.id))).toBeUndefined();
		expect(expectOk(updatedNotes.ids())).toEqual([]);
	});

	test('a row the newer release cannot read is reported, not dropped', () => {
		// The other direction, which is what the updated device sees for every row
		// the un-updated one writes. A row it cannot read is still a row and is
		// still in the CRDT: the failure names the address and carries what did
		// pass, so the application can repair it or show it.
		const { wire, updatedNotes, older, olderNotes } = pair(newerLens);
		const made = expectOk(olderNotes.create({ title: 'Groceries' }));
		older.client.flush();
		wire.settle();

		const seen = expectOk(updatedNotes.list());
		expect(seen.rows).toEqual([]);
		expect(seen.nonconforming).toHaveLength(1);
		const failure = seen.nonconforming[0];
		expect(failure?.address).toEqual({
			namespace: 'so.epicenter.honeycrisp',
			tableName: 'notes',
			rowId: made.id,
		});
		expect(failure?.issues.map((issue) => issue.field)).toEqual(['pinned']);
		// What could be read, which is what recovery is composed from.
		expect(failure?.conforming).toEqual({ id: made.id, title: 'Groceries' });
		expect(failure?.raw).toEqual({ title: 'Groceries' });
		// And it was not dropped on the way in: the row is on this device.
		expect(expectOk(updatedNotes.ids())).toEqual([made.id]);
	});

	test('CONTROL: a row the newer release CAN read is in rows and reported nowhere', () => {
		// Without this, "reported rather than dropped" would pass for a lens that
		// reports every row it is handed.
		const { wire, updated, updatedNotes, older } = pair(newerLens);
		const made = expectOk(
			updatedNotes.create({ title: 'Groceries', pinned: false }),
		);
		updated.client.flush();
		wire.settle();
		expect(older.titles()).toEqual(['Groceries']);

		const seen = expectOk(updatedNotes.list());
		expect(seen.nonconforming).toEqual([]);
		expect(seen.rows).toEqual([
			{ id: made.id, title: 'Groceries', pinned: false },
		]);
	});

	test('a table the older release does not declare waits in the CRDT for one that does', () => {
		// The claim `rebuildAllProjections` makes in a comment, checked across the
		// transport rather than inside one store. The older device relays and stores
		// rows of a table it has no name for, and they are there the moment it is
		// updated, without anybody re-sending anything.
		const { wire, updated, updatedNotes, older } = pair(twoTableLens);
		expectOk(updatedNotes.create({ title: 'Groceries' }));
		const task = expectOk(
			tableOf(updated.bound, 'tasks').create({ label: 'buy milk' }),
		);
		updated.client.flush();
		wire.settle();

		expect(older.titles()).toEqual(['Groceries']);
		// It holds no handle for the table and no relation to query it through.
		expect(older.bound.tables.tasks).toBeUndefined();
		expect(
			expectOk(
				older.bound.query`SELECT name FROM sqlite_schema WHERE name = 'tasks'`,
			),
		).toEqual([]);

		// The device is updated: same store, same file, a lens that now declares it.
		const rebound = expectOk(older.store.bind(twoTableLens));
		expect(expectOk(tableOf(rebound, 'tasks').list()).rows).toEqual([
			{ id: task.id, label: 'buy milk' },
		]);
		// Through the projection too, so this is not just a CRDT read: binding
		// rebuilt the relation from rows that were already here.
		expect(expectOk(rebound.query`SELECT id, label FROM tasks`)).toEqual([
			{ id: task.id, label: 'buy milk' },
		]);
	});

	test('updating a device to a lens with a new FIELD reprojects and keeps working', () => {
		// The mismatch seen from the device that is doing the updating, which is the
		// likeliest way a lens ever changes. `applyProjectionSchema` is
		// `CREATE TABLE IF NOT EXISTS`, so binding a lens that added a field to a
		// table this store already projected leaves the relation as the old lens
		// built it, and the rebuild that follows inserts into a column that is not
		// there.
		const wire = createWire();
		const { hub } = openAuthority();
		const updating = openReplica('updating', hub, wire);
		const other = openReplica('other', hub, wire);
		const otherNotes = tableOf(other.bound, 'notes');
		updating.connect();
		other.connect();
		expectOk(otherNotes.create({ title: 'Groceries' }));
		other.client.flush();
		wire.settle();
		expect(updating.titles()).toEqual(['Groceries']);

		// This used to kill the store outright. `applyProjectionSchema` was
		// `CREATE TABLE IF NOT EXISTS`, so the old relation stayed without the new
		// column and `rebuildProjectedTable` failed with "no column named pinned".
		// `persist` fails closed, so the damage was not confined to the new
		// binding: the binding the app already held started returning
		// `StorageFailed` for every read and write, and through the transport it
		// was indistinguishable from a poison pill. Adding a field is the most
		// ordinary lens change there is.
		const rebound = expectOk(updating.store.bind(newerLens));

		const reboundNotes = tableOf(rebound, 'notes');
		// The pre-existing row is REPORTED rather than repaired or dropped, because
		// `pinned` is declared without a default and that row predates it
		// (ADR-0213). It is still in the CRDT, and `conforming` carries what could
		// be read, which is the whole recovery composition.
		const listed = expectOk(reboundNotes.list());
		expect(listed.rows).toHaveLength(0);
		expect(listed.nonconforming).toHaveLength(1);
		expect(listed.nonconforming[0]?.conforming).toMatchObject({
			title: 'Groceries',
		});
		expect(expectOk(reboundNotes.ids())).toHaveLength(1);

		// CONTROL: the new column really is there now, which is exactly what the
		// old relation was missing. A drop that failed to recreate fails here.
		expect(
			expectOk(reboundNotes.create({ title: 'Bread', pinned: true })).pinned,
		).toBe(true);

		// And it keeps syncing rather than stopping dead at the next entry.
		expectOk(otherNotes.create({ title: 'Milk' }));
		other.client.flush();
		wire.settle();
		expect(updating.client.status().lastError).toBeUndefined();
		expect(expectOk(reboundNotes.ids())).toHaveLength(3);
	});

	test('CONTROL: updating a device to a lens with a new TABLE leaves it working', () => {
		// The isolation, and the reason the defect above is about a column rather
		// than about rebinding at all. A new table is a new relation, which
		// `CREATE TABLE IF NOT EXISTS` does create, so the same move on the same
		// store succeeds and the device keeps syncing.
		const wire = createWire();
		const { hub } = openAuthority();
		const updating = openReplica('updating', hub, wire);
		const other = openReplica('other', hub, wire);
		const otherNotes = tableOf(other.bound, 'notes');
		updating.connect();
		other.connect();
		expectOk(otherNotes.create({ title: 'Groceries' }));
		other.client.flush();
		wire.settle();

		const rebound = expectOk(updating.store.bind(twoTableLens));

		expect(expectOk(tableOf(rebound, 'tasks').list()).rows).toEqual([]);
		expectOk(otherNotes.create({ title: 'Bread' }));
		other.client.flush();
		wire.settle();
		expect(updating.titles()).toEqual(['Bread', 'Groceries']);
		expect(updating.client.status().lastError).toBeUndefined();
	});

	test('CONTROL: the new table on a device that never received them holds nothing', () => {
		// Without this, the rebind above would pass for a bind that invents rows, or
		// for a `tasks` relation that was somehow already populated.
		const wire = createWire();
		const { hub } = openAuthority();
		const absent = openReplica('absent', hub, wire);

		const rebound = expectOk(absent.store.bind(twoTableLens));

		expect(expectOk(tableOf(rebound, 'tasks').list()).rows).toEqual([]);
	});
});

/**
 * A deterministic pseudo-random source.
 *
 * Seeded so a failure is reproducible: the seed is printed with any failure and
 * replaying it replays the exact schedule. `Math.random` would make a red run
 * unreproducible, which is the difference between a fuzz that finds bugs and
 * one that only reports them.
 */
function createRandom(seed: number) {
	let state = seed >>> 0;
	return {
		next(): number {
			// xorshift32, chosen because it is four lines and needs no library.
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return (state >>> 0) / 0x1_0000_0000;
		},
		below(bound: number): number {
			return Math.floor(this.next() * bound);
		},
		chance(probability: number): boolean {
			return this.next() < probability;
		},
	};
}

/**
 * Random operations against several replicas, then everyone must agree.
 *
 * The point is to generate schedules nobody designed. Every other test here
 * asserts a scenario someone imagined, so it can only find bugs someone already
 * imagined; the two real defects this transport shipped were both found by
 * running it rather than by testing it.
 *
 * The invariant is exact rather than statistical, which is what makes a failure
 * mean something. **A replica only ever updates or deletes rows it created
 * itself**, so there is no concurrent write to one field and the final state is
 * computable in a plain `Map`: every row created and not deleted, with the last
 * title its owner gave it, present on every replica exactly once.
 */
function fuzz(
	seed: number,
	{ replicas, rounds }: { replicas: number; rounds: number },
) {
	const random = createRandom(seed);
	const wire = createWire();
	const { authority, hub } = openAuthority(TINY_FLOOR);
	const devices = Array.from({ length: replicas }, (_, index) =>
		openReplica(`device-${index}`, hub, wire),
	);
	/** What every replica must end up holding, tracked outside the system. */
	const expected = new Map<string, string>();
	/** Which rows each device owns, so nothing ever writes to another's row. */
	const owned = devices.map(() => [] as string[]);
	const online = devices.map(() => false);
	const seen = { creates: 0, updates: 0, deletes: 0, drops: 0, prose: 0 };

	const connect = (index: number) => {
		if (online[index]) return;
		devices[index]?.connect();
		online[index] = true;
	};
	const disconnect = (index: number) => {
		if (!online[index]) return;
		devices[index]?.disconnect();
		online[index] = false;
		seen.drops += 1;
	};

	for (let index = 0; index < replicas; index += 1) connect(index);

	for (let round = 0; round < rounds; round += 1) {
		const index = random.below(replicas);
		const device = devices[index];
		const mine = owned[index];
		if (device === undefined || mine === undefined) continue;

		const roll = random.next();
		if (roll < 0.45 || mine.length === 0) {
			const title = `r${round} from ${index}`;
			const made = expectOk(device.db.tables.notes.create({ title }));
			mine.push(made.id);
			expected.set(made.id, title);
			seen.creates += 1;
		} else if (roll < 0.65) {
			const rowId = mine[random.below(mine.length)] as string;
			const title = `r${round} edited by ${index}`;
			expectOk(device.db.tables.notes.update(rowId, { title }));
			expected.set(rowId, title);
			seen.updates += 1;
		} else if (roll < 0.78) {
			const at = random.below(mine.length);
			const rowId = mine[at] as string;
			expectOk(device.db.tables.notes.delete(rowId));
			mine.splice(at, 1);
			expected.delete(rowId);
			seen.deletes += 1;
		} else {
			// Prose, which is the one thing that reaches storage without going
			// through a store verb.
			const rowId = mine[random.below(mine.length)] as string;
			const text = device.db.tables.notes
				.document(rowId)
				?.get('editor', 'text');
			text?.applyDelta(text.change.insert('x') as never);
			seen.prose += 1;
		}

		if (random.chance(0.6)) device.client.flush();
		if (random.chance(0.5)) wire.settle();
		if (random.chance(0.12)) disconnect(random.below(replicas));
		if (random.chance(0.25)) connect(random.below(replicas));
	}

	// Everyone comes back and everything drains. A replica reporting `needsResync`
	// is reconnected, which is the repair a caller owes it.
	for (let index = 0; index < replicas; index += 1) connect(index);
	wire.settle();
	for (let index = 0; index < replicas; index += 1) {
		if (devices[index]?.client.status().needsResync !== true) continue;
		disconnect(index);
		connect(index);
		wire.settle();
	}
	for (const device of devices) device.client.flush();
	wire.settle();
	// A second pass, because a flush can only carry what the previous settle
	// delivered, and a device that reconnected last needs one more exchange.
	for (const device of devices) device.client.flush();
	wire.settle();

	return { devices, authority, expected, seen };
}

describe('random schedules, and everyone still agrees', () => {
	for (const seed of [1, 7, 12345, 987654321]) {
		test(`seed ${seed}: every replica holds exactly what was written`, () => {
			const { devices, expected, seen } = fuzz(seed, {
				replicas: 3,
				rounds: 220,
			});

			const wanted = [...expected.values()].sort();
			for (const device of devices) {
				// Compared against a model kept OUTSIDE the system, so this cannot be
				// satisfied by every replica agreeing on the wrong thing, which is
				// what a convergence-only assertion would accept.
				expect(device.titles()).toEqual(wanted);
				expect(device.client.status().unresolvedDependencies).toBe(false);
				expect(device.client.status().lastError).toBeUndefined();
			}

			// CONTROLS: a schedule that never deleted, never disconnected or never
			// snapshotted would pass the assertions above while testing none of the
			// paths this fuzz exists for.
			expect(seen.creates).toBeGreaterThan(10);
			expect(seen.deletes).toBeGreaterThan(0);
			expect(seen.drops).toBeGreaterThan(0);
			expect(seen.prose).toBeGreaterThan(0);
			expect(wanted.length).toBeGreaterThan(10);
		});
	}

	test('CONTROL: the model notices when a replica is missing a row', () => {
		// Without this, `titles()` compared against a model proves nothing unless
		// the comparison can actually fail. A row created on a device that never
		// reconnects must NOT satisfy it.
		const { devices, expected } = fuzz(42, { replicas: 2, rounds: 60 });
		const first = devices[0];
		if (first === undefined) throw new Error('no device');
		expected.set('never-synchronised', 'a row nobody has');

		expect(first.titles()).not.toEqual([...expected.values()].sort());
	});
});

describe('one verb publishes the next document (ADR-0231)', () => {
	/** Sync `count` notes through `replica`, so the log has a real tail. */
	function author(
		wire: Wire,
		replica: ReturnType<typeof openReplica>,
		count: number,
		prefix = 'note',
	): void {
		for (let index = 0; index < count; index += 1) {
			expectOk(replica.db.tables.notes.create({ title: `${prefix} ${index}` }));
			replica.client.flush();
			wire.settle();
		}
	}

	test('a replace publishes a NEW document: fresh id, and a log that starts over', () => {
		const { wire, authority, phone } = setup();
		phone.connect();
		author(wire, phone, 5);
		const before = expectOk(authority.document());

		const published = expectOk(
			authority.replace({
				fromDocument: before,
				bytes: phone.store.encodeStateSince(),
			}),
		);

		// The workspace survives; the document does not. A fresh id names the
		// new history, and its log is its own: the replacement is the snapshot
		// at position 1.
		expect(published).not.toBe(before);
		expect(expectOk(authority.document())).toBe(published);
		expect(expectOk(authority.head())).toBe(1);
		expect(expectOk(authority.snapshotPosition())).toBe(1);
		// The old document is gone whole: no log entries, no older snapshot.
		expect(expectOk(authority.since(0, 1_000))).toEqual([]);
	});

	test('fromDocument is compare-and-swap: a miss changes nothing and answers with the current id', () => {
		const { wire, authority, phone } = setup();
		phone.connect();
		author(wire, phone, 3);
		const original = expectOk(authority.document());
		const first = expectOk(
			authority.replace({
				fromDocument: original,
				bytes: phone.store.encodeStateSince(),
			}),
		);
		const snapshotBefore = expectOk(authority.snapshot());

		// The loser of a concurrent pair, or the crash-replay of a rebuild that
		// already landed: both arrive naming a document that is no longer
		// current, and neither may republish stale-built bytes over the winner.
		const missed = authority.replace({
			fromDocument: original,
			bytes: new Uint8Array([1, 2, 3]),
		});

		expect(missed.error?.name).toBe('DocumentMoved');
		expect(
			missed.error?.name === 'DocumentMoved' ? missed.error.document : '',
		).toBe(first);
		// Atomicity's observable half: a refused replace left every table alone.
		expect(expectOk(authority.document())).toBe(first);
		expect(expectOk(authority.head())).toBe(1);
		expect(expectOk(authority.snapshot())?.bytes).toEqual(
			snapshotBefore?.bytes as Uint8Array,
		);
	});

	test('atHead is a lease: an entry landing mid-swap refuses a reclaim, and omitting it lets a reset through', () => {
		const { wire, authority, phone } = setup();
		phone.connect();
		author(wire, phone, 3);
		const document = expectOk(authority.document());
		const built = expectOk(authority.head());

		// Another device's entry lands between building the replacement and
		// posting it. Reclaim promised "same data", so it must be refused.
		author(wire, phone, 1, 'landed mid-swap');
		const refused = authority.replace({
			fromDocument: document,
			atHead: built,
			bytes: phone.store.encodeStateSince(),
		});
		expect(refused.error?.name).toBe('HeadMoved');
		expect(refused.error?.name === 'HeadMoved' ? refused.error.head : -1).toBe(
			built + 1,
		);
		expect(expectOk(authority.document())).toBe(document);

		// Reset and restore discard entries on purpose, so they omit the lease
		// and the same moved head does not stop them.
		const reset = expectOk(
			authority.replace({
				fromDocument: document,
				bytes: new Uint8Array(Y.encodeStateAsUpdateV2(new Y.Doc({ gc: true }))),
			}),
		);
		expect(reset).not.toBe(document);
		expect(expectOk(authority.head())).toBe(1);
	});

	test('a fresh replica joining at cursor 0 receives the new document and nothing retired', () => {
		const { wire, authority, phone, laptop } = setup();
		phone.connect();
		const secret = 'RETIRED-CANARY-secret';
		const note = expectOk(phone.db.tables.notes.create({ title: secret }));
		phone.client.flush();
		wire.settle();
		expectOk(phone.db.tables.notes.delete(note.id));
		author(wire, phone, 4, 'kept');

		// Reclaim: same live data, re-minted, zero tombstones. The generic
		// re-encoding walk is future work; a fresh document holding the same rows
		// is the same shape from the authority's blind point of view.
		const reborn = openReplica('reborn', createSyncHub({ authority }), wire);
		for (const title of phone.titles()) {
			expectOk(reborn.db.tables.notes.create({ title }));
		}
		expectOk(
			authority.replace({
				fromDocument: expectOk(authority.document()),
				bytes: reborn.store.encodeStateSince(),
			}),
		);

		laptop.connect();
		wire.settle();
		expect(laptop.titles()).toEqual(phone.titles());
		// The new document's log is its own: the snapshot sits at position 1.
		expect(laptop.client.status().cursor).toBe(1);
		expect(laptop.client.status().unresolvedDependencies).toBe(false);
		// And the retired history is not merely unsent: the authority no longer
		// holds it at all.
		const stored = [
			...(expectOk(authority.snapshot()) === undefined
				? []
				: [expectOk(authority.snapshot())?.bytes as Uint8Array]),
			...expectOk(authority.since(0, 1_000)).map((entry) => entry.bytes),
		];
		const haystack = Buffer.concat(
			stored.map((bytes) => Buffer.from(bytes)),
		).toString('latin1');
		expect(haystack).not.toContain(secret);
		expect(haystack).toContain('kept 3');
	});

	test('ordinary sync continues inside the new document, on its own log', () => {
		const { wire, authority, phone } = setup();
		phone.connect();
		author(wire, phone, 2);
		expectOk(
			authority.replace({
				fromDocument: expectOk(authority.document()),
				bytes: phone.store.encodeStateSince(),
			}),
		);

		const writer = openReplica('writer', createSyncHub({ authority }), wire);
		// Boot after the funeral: a wiped file joins at zero and catches up.
		writer.connect();
		wire.settle();
		expectOk(writer.db.tables.notes.create({ title: 'after the break' }));
		writer.client.flush();
		wire.settle();

		// Snapshot at 1, the write at 2: the new document counts for itself.
		expect(expectOk(authority.head())).toBe(2);
		expect(writer.titles()).toContain('after the break');
	});

	test("replaceSnapshot keeps its own guard: a document replace does not weaken the in-document recap's refusal", () => {
		const { wire, authority, phone } = setup();
		phone.connect();
		author(wire, phone, 2);
		expectOk(
			authority.replace({
				fromDocument: expectOk(authority.document()),
				bytes: phone.store.encodeStateSince(),
			}),
		);

		// The recap's invariant is COVERAGE: never past the head, never backwards.
		const head = expectOk(authority.head());
		const past = authority.replaceSnapshot(head + 1, new Uint8Array([0]));
		expect(past.error?.name).toBe('SnapshotRefused');
		const backwards = authority.replaceSnapshot(head, new Uint8Array([0]));
		expect(backwards.error?.name).toBe('SnapshotRefused');
	});

	test('a redelivered adoption is free: a replica that already adopted reconnects and nothing repeats', () => {
		const { wire, authority, phone, laptop } = setup();
		phone.connect();
		author(wire, phone, 3);
		expectOk(
			authority.replace({
				fromDocument: expectOk(authority.document()),
				bytes: phone.store.encodeStateSince(),
			}),
		);
		laptop.connect();
		wire.settle();
		const adopted = laptop.titles();

		// The crash-shaped path: the socket died right after adoption, and boot
		// dials again from the durable cursor. The catch-up finds nothing to send.
		laptop.disconnect();
		laptop.connect();
		wire.settle();

		expect(laptop.titles()).toEqual(adopted);
		expect(laptop.client.status().lastError).toBeUndefined();
		expect(laptop.client.status().needsResync).toBe(false);
	});
});

describe('admission is one equality: a replica of a replaced document gets the announcement and nothing else (ADR-0231)', () => {
	test('never admitted: the announcement, no history, and its pushes land nowhere', () => {
		const { wire, authority, hub, phone } = setup();
		phone.connect();
		for (let index = 0; index < 3; index += 1) {
			expectOk(phone.db.tables.notes.create({ title: `note ${index}` }));
			phone.client.flush();
			wire.settle();
		}
		const retired = expectOk(authority.document());
		expectOk(
			authority.replace({
				fromDocument: retired,
				bytes: phone.store.encodeStateSince(),
			}),
		);
		const membersBefore = hub.attached();

		// A connection from the old document, joined directly so the verdict and
		// every byte it is ever sent are observable. It declares the identity
		// it stamped in the old document, which no longer matches.
		const sent: Uint8Array[] = [];
		const stale: HubConnection = {
			cursor: 2,
			document: retired,
			send: (bytes) => sent.push(bytes),
		};
		expect(hub.join(stale)).toBe('retired');

		// Membership is the whole guard: not a member, so it was handed no
		// snapshot and no entries, only the announcement.
		expect(hub.attached()).toBe(membersBefore);
		const frames = sent.map((bytes) => expectOk(decodeFrame(bytes)));
		expect(frames).toEqual([
			{ kind: 'document', id: expectOk(authority.document()) },
		]);

		// And the append direction dies at the same absence: its push reaches no
		// log and earns no answer, not even a refusal.
		const headBefore = expectOk(authority.head());
		hub.receive(
			stale,
			encodeFrame({
				kind: 'push',
				submission: 1,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array([1, 2, 3]),
			}),
		);
		expect(expectOk(authority.head())).toBe(headBefore);
		expect(sent).toHaveLength(1);
	});

	test('an undeclared nonzero cursor is never admitted: the former protocol has no fallback', () => {
		// A reading position without a document names bytes nothing durable can
		// place, and the clean break refuses to guess. No replace is needed for
		// the refusal: the shape itself is unservable.
		const { wire, authority, hub, phone } = setup();
		phone.connect();
		expectOk(phone.db.tables.notes.create({ title: 'current' }));
		phone.client.flush();
		wire.settle();

		const sent: Uint8Array[] = [];
		const undeclared: HubConnection = {
			cursor: 1,
			document: undefined,
			send: (bytes) => sent.push(bytes),
		};
		expect(hub.join(undeclared)).toBe('retired');
		expect(hub.attached()).toBe(1);
		const frames = sent.map((bytes) => expectOk(decodeFrame(bytes)));
		expect(frames).toEqual([
			{ kind: 'document', id: expectOk(authority.document()) },
		]);
	});

	test('a driven stale replica concludes superseded, and its rows are never soup', () => {
		const { wire, authority, phone, laptop } = setup();
		phone.connect();
		laptop.connect();
		expectOk(phone.db.tables.notes.create({ title: 'old document' }));
		phone.client.flush();
		wire.settle();
		const before = laptop.titles();
		expect(before).toEqual(['old document']);
		phone.disconnect();
		laptop.disconnect();

		expectOk(
			authority.replace({
				fromDocument: expectOk(authority.document()),
				bytes: phone.store.encodeStateSince(),
			}),
		);

		// The laptop returns from the old document: it draws the conclusion, and
		// nothing about its document changed, because nothing was delivered to
		// merge. Adoption is its host's discard-and-reload, not a code path here.
		laptop.connect();
		wire.settle();
		expect(laptop.client.status().superseded).toBe(true);
		expect(laptop.titles()).toEqual(before);
		expect(laptop.client.status().cursor).toBe(1);
	});

	test('an unnameable document fails closed: no admission and no frame', () => {
		const { authority } = openAuthority();
		const broken: SyncAuthority = {
			...authority,
			document: () => AuthorityError.StorageFailed({ cause: new Error('io') }),
		};
		const hub = createSyncHub({ authority: broken });
		const sent: Uint8Array[] = [];
		const connection: HubConnection = {
			cursor: 5,
			document: undefined,
			send: (bytes) => sent.push(bytes),
		};

		// Admitting unchecked could seat a stale replica; announcing a document
		// the authority never named could discard a healthy one. Both
		// directions fail closed: plain refusal, ordinary client backoff.
		expect(hub.join(connection)).toBe('unavailable');
		expect(hub.attached()).toBe(0);
		expect(sent).toHaveLength(0);
	});
});
