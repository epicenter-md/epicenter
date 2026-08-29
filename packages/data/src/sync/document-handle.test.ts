/**
 * A handle owning its own lifetime, which is what replaces the manager.
 *
 * The tests that matter are the ones about closing: a handle that leaves a
 * timer, a listener or a hide hook behind is a leak nothing enumerates, and
 * nothing enumerating them is the whole point.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';

import 'fake-indexeddb/auto';

import { openDurableRecord } from '../store/record.js';
import {
	type DocumentAuthority,
	openDocumentAuthority,
} from './document-authority.js';
import { type DocumentSocket, encodeDocumentFrame } from './document-frames.js';
import { openDocumentHandle, REMOTE_ORIGIN } from './document-handle.js';
import { createDocumentHub } from './document-hub.js';

let addresses = 0;
let authority: DocumentAuthority;

/** A timer a test drives, so nothing here waits on a clock. */
function manualClock() {
	let pending: (() => void) | undefined;
	return {
		schedule: (run: () => void) => {
			pending = run;
			return () => {
				pending = undefined;
			};
		},
		pending: () => pending !== undefined,
		fire() {
			const run = pending;
			pending = undefined;
			run?.();
		},
	};
}

/** A record of its own, so no two handles here share a chain by accident. */
function record(floorBytes?: number) {
	addresses += 1;
	return openDurableRecord({
		name: `epicenter/so.epicenter.test/handle-${addresses}/gen/1`,
		floorBytes,
	});
}

beforeEach(() => {
	authority = openDocumentAuthority({
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
	});
});

describe('the handle appends now and folds later', () => {
	test('a local edit is durable before the timer has fired', async () => {
		const clock = manualClock();
		const store = await record();
		const handle = await openDocumentHandle({
			record: store,
			doc: 'app',
			schedule: clock.schedule,
		});

		handle.document.transact(() =>
			handle.document.get('notes').setAttr('a' as never, 1 as never),
		);
		// This test asserted the opposite until ADR-0280. Arming a timer and
		// writing on it is the window that lost a person's sentence, so the
		// append happens on the edit and the timer is left holding the fold.
		await Promise.resolve();
		expect(await store.read('app')).toHaveLength(1);
		expect(clock.pending()).toBe(true);
		await handle.close();
	});

	test('settling with nothing worth folding leaves the chain alone', async () => {
		const clock = manualClock();
		const store = await record();
		const handle = await openDocumentHandle({
			record: store,
			doc: 'app',
			schedule: clock.schedule,
		});
		handle.document.transact(() =>
			handle.document.get('notes').setAttr('a' as never, 1 as never),
		);
		await Promise.resolve();

		await handle.settle();
		// One record in, one record out: a fold under the floor buys nothing,
		// and `settle` is allowed to do nothing at all.
		expect(await store.read('app')).toHaveLength(1);
		expect(clock.pending()).toBe(false);
		await handle.close();
	});

	test('settling over the floor collapses the chain to one record', async () => {
		// A floor a handful of small updates can clear, so the fold is reachable
		// without building a document actually worth folding.
		const store = await record(1);
		const handle = await openDocumentHandle({
			record: store,
			doc: 'app',
			schedule: () => () => undefined,
		});
		for (let index = 0; index < 6; index += 1) {
			handle.document.transact(() =>
				handle.document
					.get('notes')
					.setAttr(`k${index}` as never, index as never),
			);
		}
		await Promise.resolve();
		expect((await store.read('app')).length).toBeGreaterThan(1);

		await handle.settle();
		expect(await store.read('app')).toHaveLength(1);
		await handle.close();
	});

	test('reopening the same key finds what was written', async () => {
		const store = await record();
		const first = await openDocumentHandle({ record: store, doc: 'app' });
		first.document.transact(() =>
			first.document.get('notes').setAttr('a' as never, 1 as never),
		);
		await first.close();

		const second = await openDocumentHandle({ record: store, doc: 'app' });
		expect(second.document.get('notes').getAttrs()).toEqual({ a: 1 });
		await second.close();
	});
});

describe('closing leaves nothing behind', () => {
	test('close settles first, so the last edit reaches the peer', async () => {
		const clock = manualClock();
		const store = await record();
		const handle = await openDocumentHandle({
			record: store,
			doc: 'app',
			schedule: clock.schedule,
		});
		const sent: Uint8Array[] = [];
		handle.attach({ send: (bytes) => sent.push(bytes) });
		// A peer that says what it has, because a replica cannot push until it
		// has something to diff against. Without this the assertion below would
		// pass for the wrong reason.
		handle.receive(
			encodeDocumentFrame({
				kind: 'step1',
				stateVector: new Uint8Array(Y.encodeStateVector(new Y.Doc())),
			}),
		);
		const afterHandshake = sent.length;

		handle.document.transact(() =>
			handle.document.get('notes').setAttr('typed' as never, 'last' as never),
		);
		// Durability is not what this tests: the append already landed, so an
		// assertion about storage here would pass whether or not `close`
		// settled. What close-settles-first still buys is the push, and a route
		// change closes with the timer armed and the peer not yet told.
		expect(sent.length).toBe(afterHandshake);
		await handle.close();
		expect(sent.length).toBeGreaterThan(afterHandshake);

		const reopened = await openDocumentHandle({ record: store, doc: 'app' });
		expect(reopened.document.get('notes').getAttrs()).toEqual({
			typed: 'last',
		});
		await reopened.close();
	});

	test('closing disarms a timer that was already running', async () => {
		const clock = manualClock();
		const handle = await openDocumentHandle({
			record: await record(),
			doc: 'app',
			schedule: clock.schedule,
		});
		handle.document.transact(() =>
			handle.document.get('notes').setAttr('a' as never, 1 as never),
		);
		expect(clock.pending()).toBe(true);

		// The leak this names: a timer left armed after close fires into a
		// destroyed document. Asserting it from the armed state is the only
		// version of this test that can fail.
		await handle.close();
		expect(clock.pending()).toBe(false);
	});

	test('a second handle on one address is refused, not tolerated', async () => {
		const store = await record();
		const first = await openDocumentHandle({ record: store, doc: 'app' });

		// Two openers each fold a state encoded from a document that never saw
		// the other's edits, and the delete range sweeps them: nine edits in,
		// one out, no error. The map that used to prevent this lived in the
		// manager; this is the tripwire under it.
		await expect(
			openDocumentHandle({ record: store, doc: 'app' }),
		).rejects.toBeDefined();

		// A different document in the same record is not the same address.
		const other = await openDocumentHandle({ record: store, doc: 'notes/a' });
		await other.close();

		await first.close();
		const reopened = await openDocumentHandle({ record: store, doc: 'app' });
		await reopened.close();
	});

	test('closing twice is not an error', async () => {
		const handle = await openDocumentHandle({
			record: await record(),
			doc: 'app',
		});
		await handle.close();
		await handle.close();
	});
});

describe('a handle with a socket', () => {
	test('attaching syncs both ways, and settling pushes local work', async () => {
		const hub = createDocumentHub({ authority });
		const clock = manualClock();
		const handle = await openDocumentHandle({
			record: await record(),
			doc: 'app',
			schedule: clock.schedule,
		});

		// The two directions, written out because they are the whole wiring a
		// host does: what the hub sends reaches the handle, and what the handle
		// sends reaches the hub.
		const hubSide: DocumentSocket = {
			send: (bytes) => {
				handle.receive(bytes);
			},
		};
		const handleSide: DocumentSocket = {
			send: (bytes) => {
				hub.receive(hubSide, bytes);
			},
		};
		hub.join(hubSide);
		handle.attach(handleSide);

		handle.document.transact(() =>
			handle.document.get('notes').setAttr('mine' as never, 1 as never),
		);
		await handle.settle();

		const fresh = new Y.Doc({ gc: true });
		Y.applyUpdateV2(fresh, authority.since(Y.encodeStateVector(fresh)));
		expect(fresh.get('notes').getAttrs()).toEqual({ mine: 1 });
		await handle.close();
	});

	test('a second handle attaching is caught up by its own announcement', async () => {
		const hub = createDocumentHub({ authority });
		const wire = async () => {
			const handle = await openDocumentHandle({
				record: await record(),
				doc: 'app',
			});
			const hubSide: DocumentSocket = {
				send: (bytes) => {
					handle.receive(bytes);
				},
			};
			hub.join(hubSide);
			handle.attach({
				send: (bytes) => {
					hub.receive(hubSide, bytes);
				},
			});
			return handle;
		};

		const phone = await wire();
		phone.document.transact(() =>
			phone.document.get('notes').setAttr('early' as never, 1 as never),
		);
		await phone.settle();

		const laptop = await wire();
		expect(laptop.document.get('notes').getAttrs()).toEqual({ early: 1 });
		await phone.close();
		await laptop.close();
	});
});

describe('a deleted chain must not come back', () => {
	test('discard detaches the document, so a late edit cannot rewrite a swept chain', async () => {
		const clock = manualClock();
		const store = await record(1);
		const handle = await openDocumentHandle({
			record: store,
			doc: 'notes/gone',
			schedule: clock.schedule,
		});

		handle.document.transact(() =>
			handle.document.get('body').setAttr('text' as never, 'secret' as never),
		);
		await Promise.resolve();
		expect((await store.read('notes/gone')).length).toBeGreaterThan(0);

		// The row is deleted: the scalar leaves the application document and
		// this chain is swept.
		await store.retire('notes/gone');
		expect(await store.read('notes/gone')).toEqual([]);

		// The document is still live and its `updateV2` listener is still
		// attached, so anything that touches it appends to the chain that was
		// just swept. The row is gone, so nothing names the address, and the
		// bytes sit there until `documents()` enumerates them for an export
		// (ADR-0286) and a deleted note comes back.
		//
		// A late edit is not exotic: an editor pane closes on its own schedule,
		// and a pending transaction lands after the delete commits.
		handle.discard();
		handle.document.transact(() =>
			handle.document.get('body').setAttr('text' as never, 'more' as never),
		);
		await Promise.resolve();

		expect(await store.read('notes/gone')).toEqual([]);
		store.close();
	});

	test('discard does not fold, because folding a swept chain rewrites it whole', async () => {
		const clock = manualClock();
		const store = await record(1);
		const handle = await openDocumentHandle({
			record: store,
			doc: 'notes/folded',
			schedule: clock.schedule,
		});
		handle.document.transact(() =>
			handle.document.get('body').setAttr('text' as never, 'secret' as never),
		);
		await Promise.resolve();
		await store.retire('notes/folded');

		// `close()` settles first, and settling folds. Today `retire` zeroes the
		// byte totals so `shouldFold` says no, which means this is guarded by an
		// accounting detail rather than by the teardown. `discard` is the
		// teardown that does not depend on that, and a timer still armed against
		// the document must not reach a fold either.
		handle.discard();
		clock.fire();
		await Promise.resolve();

		expect(await store.read('notes/folded')).toEqual([]);
		store.close();
	});

	test('discard is idempotent, and a close after it does not settle either', async () => {
		const clock = manualClock();
		const store = await record(1);
		const handle = await openDocumentHandle({
			record: store,
			doc: 'notes/twice',
			schedule: clock.schedule,
		});
		handle.document.transact(() =>
			handle.document.get('body').setAttr('text' as never, 'x' as never),
		);
		await Promise.resolve();
		await store.retire('notes/twice');

		// A re-run effect teardown calls what it was handed more than once, and
		// a manager that both evicts and disposes reaches both verbs.
		handle.discard();
		handle.discard();
		await handle.close();

		expect(await store.read('notes/twice')).toEqual([]);
		store.close();
	});
});

describe('a stranger is not a peer', () => {
	test('a remote frame carries an origin, and a rogue apply does not', async () => {
		const store = await record();
		const handle = await openDocumentHandle({ record: store, doc: 'app' });

		const seen: unknown[] = [];
		handle.document.on(
			'updateV2' as never,
			((_update: Uint8Array, origin: unknown) => {
				seen.push(origin);
			}) as never,
		);

		// A local commit: no origin, and `transaction.local` is true.
		handle.document.transact(() =>
			handle.document.get('notes').setAttr('mine' as never, 1 as never),
		);

		// A frame through `receive`: `REMOTE_ORIGIN`.
		const peer = new Y.Doc({ gc: true });
		peer.transact(() =>
			peer.get('notes').setAttr('theirs' as never, 2 as never),
		);
		handle.receive(
			encodeDocumentFrame({
				kind: 'update',
				update: new Uint8Array(Y.encodeStateAsUpdateV2(peer)),
			}),
		);

		// A stranger reaching the document directly: no origin, and
		// `transaction.local` is false, which is exactly what a frame applied
		// bare would have looked like. That is the whole reason for the
		// sentinel: a listener cannot otherwise tell these two apart, and a
		// stranger's bytes with missing dependencies are buffered by Yjs and
		// held by nobody.
		const rogue = new Y.Doc({ gc: true });
		rogue.transact(() =>
			rogue.get('notes').setAttr('forged' as never, 3 as never),
		);
		Y.applyUpdateV2(
			handle.document,
			new Uint8Array(Y.encodeStateAsUpdateV2(rogue)),
		);

		expect(seen).toEqual([null, REMOTE_ORIGIN, null]);
		peer.destroy();
		rogue.destroy();
		await handle.close();
	});
});
