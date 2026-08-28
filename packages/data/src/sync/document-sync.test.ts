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

import { createOpfsBlobs } from '../store/blobs.opfs.js';
import { installTestOpfs } from '../store/test-opfs.js';
import {
	type DocumentAuthority,
	openDocumentAuthority,
} from './document-authority.js';
import {
	type DocumentReplica,
	openDocumentReplica,
} from './document-replica.js';

installTestOpfs();

const KEY = 'app';
let addresses = 0;

/** A device with its own durable storage, reopenable under the same address. */
function device(address: string) {
	const blobs = createOpfsBlobs({ root: address });
	return {
		blobs,
		open: () => openDocumentReplica({ blobs, key: KEY }),
	};
}

function freshDevice() {
	addresses += 1;
	return device(`epicenter/v1/so.epicenter.test/device${addresses}`);
}

/**
 * One full handshake, both directions, exactly as `y-protocols` sequences it.
 *
 * step 1 from the replica, step 2 and step 1 back from the authority, step 2
 * from the replica. Three messages, and this function is the whole client.
 */
function sync(replica: DocumentReplica, authority: DocumentAuthority): void {
	replica.receive(authority.since(replica.stateVector()));
	expectOk(authority.receive(replica.since(authority.stateVector())));
}

function attrs(replica: DocumentReplica): Record<string, unknown> {
	return replica.document.get('notes').getAttrs() as Record<string, unknown>;
}

function write(replica: DocumentReplica, key: string, value: unknown): void {
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
		await first.persist();
		first.dispose();

		const second = await machine.open();
		expect(attrs(second)).toEqual({ a: 1, b: 2 });
	});

	test('a device that persisted late re-sends, and the authority converges', async () => {
		// The ordering rule, from the safe side. This device is killed after
		// syncing but before persisting, so its next open is BEHIND what the
		// authority already has, and the handshake fills it back in.
		const machine = freshDevice();
		const first = await machine.open();
		write(first, 'a', 1);
		await first.persist();
		write(first, 'b', 2);
		sync(first, authority);
		first.dispose(); // no persist: `b` is on the server and not on disk

		const second = await machine.open();
		expect(attrs(second)).toEqual({ a: 1 });
		sync(second, authority);
		expect(attrs(second)).toEqual({ a: 1, b: 2 });
	});

	test('a device with no stored bytes is a fresh device, and needs no flag', async () => {
		const phone = await freshDevice().open();
		write(phone, 'a', 1);
		sync(phone, authority);
		await phone.persist();

		const blank = await freshDevice().open();
		expect(attrs(blank)).toEqual({});
		sync(blank, authority);
		expect(attrs(blank)).toEqual({ a: 1 });
	});
});

describe('durable and live agree', () => {
	test('what is written to the blob is what a fresh reader reconstructs', async () => {
		const machine = freshDevice();
		const replica = await machine.open();
		write(replica, 'a', 1);
		replica.document.transact(() =>
			replica.document.get('notes').setAttr('b' as never, 2 as never),
		);
		replica.document.transact(() =>
			replica.document.get('notes').deleteAttr('a'),
		);
		await replica.persist();

		const bytes = await machine.blobs.read(KEY);
		const rebuilt = new Y.Doc({ gc: true });
		Y.applyUpdateV2(rebuilt, bytes as Uint8Array);
		expect(rebuilt.get('notes').getAttrs()).toEqual(
			replica.document.get('notes').getAttrs(),
		);
	});
});
