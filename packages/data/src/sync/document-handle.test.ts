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
import type { DocumentSocket } from './document-frames.js';
import { openDocumentHandle } from './document-handle.js';
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
	test('close settles first, so the last edit is not lost', async () => {
		const clock = manualClock();
		const store = await record();
		const handle = await openDocumentHandle({
			record: store,
			doc: 'app',
			schedule: clock.schedule,
		});
		handle.document.transact(() =>
			handle.document.get('notes').setAttr('typed' as never, 'last' as never),
		);
		// Closed with the timer still armed, which is what a route change does.
		await handle.close();

		const reopened = await openDocumentHandle({ record: store, doc: 'app' });
		expect(reopened.document.get('notes').getAttrs()).toEqual({
			typed: 'last',
		});
		await reopened.close();
	});

	test('a closed handle stops arming its timer', async () => {
		const clock = manualClock();
		const handle = await openDocumentHandle({
			record: await record(),
			doc: 'app',
			schedule: clock.schedule,
		});
		await handle.close();

		handle.document.transact(() =>
			handle.document.get('notes').setAttr('after' as never, 1 as never),
		);
		expect(clock.pending()).toBe(false);
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
