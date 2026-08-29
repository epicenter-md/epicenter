/**
 * The whole model, at the smallest scale it exists at: two devices, one
 * authority, one document, and no store anywhere.
 *
 * Every test here is the three-message protocol driven by hand, so what is
 * being asserted is the DESIGN rather than a transport. If these hold, the
 * remaining work is plumbing: a socket to carry the messages a device already
 * knows how to compute, and a store to own the documents it already knows how
 * to open.
 *
 * What is worth noticing is everything the setup does not need. No cursor, no
 * outbox, no acknowledgement, no positions, no gap check, no resync, and no
 * identity beside the bytes. A device syncs by saying what it has.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';

import 'fake-indexeddb/auto';

import { openDurableRecord } from '../store/record.js';
import {
	type DocumentAuthority,
	openDocumentAuthority,
} from './document-authority.js';
import { type DocumentHandle, openDocumentHandle } from './document-handle.js';

const KEY = 'app';
let addresses = 0;

/** Nothing here is on a timer: settling is what the tests call by hand. */
const never = () => () => undefined;

/**
 * A device with its own durable storage, reopenable under the same name.
 *
 * Reopening closes the previous record first, which is what a machine coming
 * back does: one process, one connection. These tests used to leave both open
 * and pass anyway, and an audit reproduced what that hides &mdash; two records on
 * one database seed their sequences from the same disk and hand out the same
 * numbers. `openDurableRecord` refuses it now, so the shape has to be honest.
 */
function device(name: string) {
	let live: Awaited<ReturnType<typeof openDurableRecord>> | undefined;
	return {
		name,
		open: async () => {
			live?.close();
			live = await openDurableRecord({ name });
			return openDocumentHandle({ record: live, doc: KEY, schedule: never });
		},
	};
}

function freshDevice() {
	addresses += 1;
	return device(`epicenter/so.epicenter.test/sync-${addresses}/gen/1`);
}

/**
 * One full handshake, both directions, exactly as `y-protocols` sequences it.
 *
 * step 1 from the replica, step 2 and step 1 back from the authority, step 2
 * from the replica. Three messages, and this function is the whole client.
 */
function sync(replica: DocumentHandle, authority: DocumentAuthority): void {
	Y.applyUpdateV2(replica.document, authority.since(replica.stateVector()));
	expectOk(authority.receive(replica.since(authority.stateVector())));
}

function attrs(replica: DocumentHandle): Record<string, unknown> {
	return replica.document.get('notes').getAttrs() as Record<string, unknown>;
}

function write(replica: DocumentHandle, key: string, value: unknown): void {
	replica.document.transact(() =>
		replica.document.get('notes').setAttr(key as never, value as never),
	);
}

let authority: DocumentAuthority;

beforeEach(() => {
	authority = openDocumentAuthority({
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
	});
});

describe('two devices, one authority', () => {
	test('what one device writes, the other reads', async () => {
		const phone = await freshDevice().open();
		const laptop = await freshDevice().open();

		write(phone, 'title', 'hello');
		sync(phone, authority);
		sync(laptop, authority);

		expect(attrs(laptop)).toEqual({ title: 'hello' });
	});

	test('simultaneous edits to different keys both survive', async () => {
		const phone = await freshDevice().open();
		const laptop = await freshDevice().open();
		sync(phone, authority);
		sync(laptop, authority);

		write(phone, 'fromPhone', 1);
		write(laptop, 'fromLaptop', 2);
		sync(phone, authority);
		sync(laptop, authority);
		sync(phone, authority);

		expect(attrs(phone)).toEqual({ fromPhone: 1, fromLaptop: 2 });
		expect(attrs(laptop)).toEqual(attrs(phone));
	});

	test('a deletion reaches a device that never saw the row change', async () => {
		const phone = await freshDevice().open();
		const laptop = await freshDevice().open();
		write(phone, 'keep', 1);
		write(phone, 'drop', 2);
		sync(phone, authority);
		sync(laptop, authority);
		expect(attrs(laptop)).toEqual({ keep: 1, drop: 2 });

		phone.document.transact(() =>
			phone.document.get('notes').deleteAttr('drop'),
		);
		sync(phone, authority);
		sync(laptop, authority);

		expect(attrs(laptop)).toEqual({ keep: 1 });
	});
});

describe('a device that was away', () => {
	test('work done offline goes out on the next sync, in either order', async () => {
		const phone = await freshDevice().open();
		const laptop = await freshDevice().open();
		write(phone, 'early', 1);
		sync(phone, authority);
		sync(laptop, authority);

		// Both edit while neither is talking to the authority.
		write(phone, 'offlinePhone', 2);
		write(laptop, 'offlineLaptop', 3);

		// The laptop reconnects first this time; the order must not matter.
		sync(laptop, authority);
		sync(phone, authority);
		sync(laptop, authority);

		const expected = {
			early: 1,
			offlinePhone: 2,
			offlineLaptop: 3,
		};
		expect(attrs(phone)).toEqual(expected);
		expect(attrs(laptop)).toEqual(expected);
	});

	test('syncing twice with nothing new is free and changes nothing', async () => {
		const phone = await freshDevice().open();
		write(phone, 'a', 1);
		sync(phone, authority);
		const settled = authority.stateVector();

		sync(phone, authority);
		sync(phone, authority);

		expect(authority.stateVector()).toEqual(settled);
		// The 13-byte no-op: what a caught-up replica owes.
		expect(phone.since(authority.stateVector()).length).toBe(13);
	});
});

describe('what survives the tab closing', () => {
	test('a reopened device holds what it held, without asking anyone', async () => {
		const machine = freshDevice();
		const first = await machine.open();
		write(first, 'a', 1);
		write(first, 'b', 2);
		await first.settle();
		first.close();

		const second = await machine.open();
		expect(attrs(second)).toEqual({ a: 1, b: 2 });
	});

	test('a device killed mid-edit keeps what it typed, with no timer having run', async () => {
		// This test used to describe the opposite. Under a debounced whole
		// document write it asserted that work synced but not yet persisted
		// came BACK from the authority on the next open, which was true and was
		// the window ADR-0280 closed. Appending eagerly makes the loss
		// unreachable: nothing here settles, and nothing is lost.
		const machine = freshDevice();
		const first = await machine.open();
		write(first, 'a', 1);
		write(first, 'b', 2);

		const second = await machine.open();
		expect(attrs(second)).toEqual({ a: 1, b: 2 });
	});

	test('a device behind the authority is filled in by the handshake', async () => {
		const phone = await freshDevice().open();
		write(phone, 'a', 1);
		sync(phone, authority);

		const laptop = await freshDevice().open();
		expect(attrs(laptop)).toEqual({});
		sync(laptop, authority);
		expect(attrs(laptop)).toEqual({ a: 1 });
	});

	test('a device with no stored bytes is a fresh device, and needs no flag', async () => {
		const phone = await freshDevice().open();
		write(phone, 'a', 1);
		sync(phone, authority);
		await phone.settle();

		const blank = await freshDevice().open();
		expect(attrs(blank)).toEqual({});
		sync(blank, authority);
		expect(attrs(blank)).toEqual({ a: 1 });
	});
});

describe('durable and live agree', () => {
	test('what a chain stores is what a fresh reader reconstructs', async () => {
		const machine = freshDevice();
		const replica = await machine.open();
		write(replica, 'a', 1);
		replica.document.transact(() =>
			replica.document.get('notes').setAttr('b' as never, 2 as never),
		);
		replica.document.transact(() =>
			replica.document.get('notes').deleteAttr('a'),
		);
		await replica.settle();

		// Through the public surface rather than by reading storage: a chain is
		// several records where a blob was one value, so "what is on disk" is
		// only answerable by replaying it, which is what opening does.
		const rebuilt = await machine.open();
		expect(attrs(rebuilt)).toEqual(
			replica.document.get('notes').getAttrs() as Record<string, unknown>,
		);
	});
});

describe('a document neither device had yet', () => {
	/**
	 * The offline-first promise, as a test: open the app, start typing, and
	 * whether anyone had ever created this note's document is not a question you
	 * were asked.
	 *
	 * It works because of one Yjs property, pinned in
	 * `evidence/invariants.test.ts`: a ROOT is addressed by its name, so
	 * `doc.get('body')` on two devices is the same address and independent
	 * minting is not a conflict. The neighbouring test there shows the other
	 * half, that a NESTED type at a chosen key is addressed by struct and two
	 * devices minting one lose a subtree to last-writer-wins. Honeycrisp's note
	 * body is a root (`NOTE_BODY = 'body'`, reached with `doc.get`), which is
	 * what puts it on the safe side of that line.
	 */
	function body(replica: DocumentHandle) {
		return replica.document.get('body');
	}

	test('two devices create the same note body offline, and both keep their work', async () => {
		// Neither has ever synced this document. Neither knows the other exists.
		const phone = await freshDevice().open();
		const laptop = await freshDevice().open();
		phone.document.transact(() =>
			body(phone).setAttr('fromPhone' as never, 'typed here' as never),
		);
		laptop.document.transact(() =>
			body(laptop).setAttr('fromLaptop' as never, 'and here' as never),
		);

		sync(phone, authority);
		sync(laptop, authority);
		sync(phone, authority);

		const expected = { fromPhone: 'typed here', fromLaptop: 'and here' };
		expect(body(phone).getAttrs()).toEqual(expected);
		expect(body(laptop).getAttrs()).toEqual(expected);
	});

	test('the root is one root afterwards, not two', async () => {
		// The thing that would be wrong if the address were a struct rather than
		// a name: two containers, converged, with one device's work inside the
		// one that lost.
		const phone = await freshDevice().open();
		const laptop = await freshDevice().open();
		phone.document.transact(() =>
			body(phone).setAttr('a' as never, 1 as never),
		);
		laptop.document.transact(() =>
			body(laptop).setAttr('b' as never, 2 as never),
		);
		sync(phone, authority);
		sync(laptop, authority);
		sync(phone, authority);

		expect([...phone.document.share.keys()]).toEqual(['body']);
		expect([...laptop.document.share.keys()]).toEqual(['body']);
	});

	test('a device that only ever worked offline loses nothing on its first sync', async () => {
		const early = await freshDevice().open();
		early.document.transact(() => {
			body(early).setAttr('first' as never, 1 as never);
			body(early).setAttr('second' as never, 2 as never);
		});
		// Someone else got there first, through the same authority.
		const other = await freshDevice().open();
		other.document.transact(() =>
			body(other).setAttr('theirs' as never, 3 as never),
		);
		sync(other, authority);

		sync(early, authority);
		expect(body(early).getAttrs()).toEqual({
			first: 1,
			second: 2,
			theirs: 3,
		});
	});

	test('persisting an offline-created document and reopening keeps it mergeable', async () => {
		const machine = freshDevice();
		const first = await machine.open();
		first.document.transact(() =>
			body(first).setAttr('written' as never, 'offline' as never),
		);
		await first.settle();
		first.close();

		// A different device wrote to the same never-shared document meanwhile.
		const elsewhere = await freshDevice().open();
		elsewhere.document.transact(() =>
			body(elsewhere).setAttr('elsewhere' as never, 'also offline' as never),
		);
		sync(elsewhere, authority);

		const reopened = await machine.open();
		sync(reopened, authority);
		expect(reopened.document.get('body').getAttrs()).toEqual({
			written: 'offline',
			elsewhere: 'also offline',
		});
	});
});
