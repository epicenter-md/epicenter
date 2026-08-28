/**
 * Two devices and an authority, over sockets, with nothing faked in the middle.
 *
 * `transport.test.ts` drives the old hub and client through a pair of
 * in-process sockets for the reason it states: what is tested and what is
 * deployed should be the same code rather than two things that agree today.
 * Same move here, over the protocol that replaces it.
 *
 * The wiring below is the whole runtime. There is no cursor to seed, no
 * identity to stamp, no bootstrap connection, no acknowledgement to wait for,
 * and no reassembly. A device attaches, says what it has, and is told.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';

import { createOpfsBlobs } from '../store/blobs.opfs.js';
import { installTestOpfs } from '../store/test-opfs.js';
import {
	type DocumentAuthority,
	openDocumentAuthority,
} from './document-authority.js';
import type { DocumentSocket } from './document-frames.js';
import { createDocumentHub, type DocumentHub } from './document-hub.js';
import { openDocumentReplica } from './document-replica.js';
import {
	type DocumentSession,
	openDocumentSession,
} from './document-session.js';

installTestOpfs();

let addresses = 0;
let authority: DocumentAuthority;
let hub: DocumentHub;

/**
 * A device, wired to the hub through a pair of sockets that deliver
 * synchronously. Delivery order is therefore the call order, which is what
 * makes a test about convergence readable.
 */
async function device(): Promise<{
	session: DocumentSession;
	document: Y.Doc;
	persist: () => Promise<void>;
	drop(): void;
	root(): Y.Type;
}> {
	addresses += 1;
	const blobs = createOpfsBlobs({
		root: `epicenter/v1/so.epicenter.test/device${addresses}`,
	});
	const replica = await openDocumentReplica({ blobs, key: 'app' });
	const session = openDocumentSession({ replica });

	// The socket the hub holds: whatever it sends reaches the session.
	const toClient: DocumentSocket = {
		send: (bytes) => {
			session.receive(bytes);
		},
	};
	// The socket the session holds: whatever it sends reaches the hub.
	const toHub: DocumentSocket = {
		send: (bytes) => {
			hub.receive(toClient, bytes);
		},
	};

	hub.join(toClient);
	session.attach(toHub);
	return {
		session,
		document: replica.document,
		persist: () => replica.persist(),
		drop: () => {
			hub.leave(toClient);
			session.detach();
		},
		root: () => replica.document.get('notes'),
	};
}

function write(doc: Y.Doc, key: string, value: unknown): void {
	doc.transact(() => doc.get('notes').setAttr(key as never, value as never));
}

function attrs(doc: Y.Doc): Record<string, unknown> {
	return doc.get('notes').getAttrs() as Record<string, unknown>;
}

beforeEach(() => {
	authority = openDocumentAuthority({
		sqlite: createBunSqliteAdapter(new Database(':memory:')),
	});
	hub = createDocumentHub({ authority });
});

describe('a live session', () => {
	test('what one device writes reaches the other without anyone asking', async () => {
		const phone = await device();
		const laptop = await device();

		write(phone.document, 'title', 'hello');
		phone.session.flush();

		expect(attrs(laptop.document)).toEqual({ title: 'hello' });
	});

	test('a device that joins later is caught up by its own announcement', async () => {
		const phone = await device();
		write(phone.document, 'early', 1);
		phone.session.flush();

		const laptop = await device();
		expect(attrs(laptop.document)).toEqual({ early: 1 });
	});

	test('three devices converge, and the writer does not hear its own update', async () => {
		const a = await device();
		const b = await device();
		const c = await device();
		write(a.document, 'fromA', 1);
		a.session.flush();
		write(b.document, 'fromB', 2);
		b.session.flush();

		const expected = { fromA: 1, fromB: 2 };
		expect(attrs(a.document)).toEqual(expected);
		expect(attrs(b.document)).toEqual(expected);
		expect(attrs(c.document)).toEqual(expected);
	});

	test('a deletion travels like anything else', async () => {
		const phone = await device();
		const laptop = await device();
		write(phone.document, 'keep', 1);
		write(phone.document, 'drop', 2);
		phone.session.flush();
		expect(attrs(laptop.document)).toEqual({ keep: 1, drop: 2 });

		phone.document.transact(() =>
			phone.document.get('notes').deleteAttr('drop'),
		);
		phone.session.flush();
		expect(attrs(laptop.document)).toEqual({ keep: 1 });
	});
});

describe('leaving and coming back', () => {
	test('work done while detached goes out on the next attach', async () => {
		const phone = await device();
		const laptop = await device();
		write(phone.document, 'before', 1);
		phone.session.flush();

		phone.drop();
		write(phone.document, 'while-away', 2);
		write(laptop.document, 'meanwhile', 3);
		laptop.session.flush();
		expect(attrs(phone.document)).toEqual({ before: 1, 'while-away': 2 });

		// Reattaching is one announcement, and both directions resolve from it.
		const rejoined: DocumentSocket = {
			send: (bytes) => {
				phone.session.receive(bytes);
			},
		};
		hub.join(rejoined);
		phone.session.attach({
			send: (bytes) => {
				hub.receive(rejoined, bytes);
			},
		});

		const expected = { before: 1, 'while-away': 2, meanwhile: 3 };
		expect(attrs(phone.document)).toEqual(expected);
		expect(attrs(laptop.document)).toEqual(expected);
	});

	test('a device that never attached still has its own work when it does', async () => {
		const phone = await device();
		write(phone.document, 'mine', 1);
		phone.session.flush();

		const late = await device();
		write(late.document, 'theirs', 2);
		late.session.flush();

		expect(attrs(late.document)).toEqual({ mine: 1, theirs: 2 });
		expect(attrs(phone.document)).toEqual({ mine: 1, theirs: 2 });
	});
});

describe('what the hub refuses', () => {
	test('bytes that are not a frame change nothing', async () => {
		const phone = await device();
		write(phone.document, 'a', 1);
		phone.session.flush();
		const before = authority.stateVector();

		const stray: DocumentSocket = { send: () => undefined };
		hub.join(stray);
		expect(hub.receive(stray, new Uint8Array())).toBe(false);
		expect(authority.stateVector()).toEqual(before);
	});

	test('an update that will not apply is refused and never relayed', async () => {
		const phone = await device();
		const laptop = await device();
		write(phone.document, 'a', 1);
		phone.session.flush();

		const stray: DocumentSocket = { send: () => undefined };
		hub.join(stray);
		const garbage = new Uint8Array([2, 255, 255, 255, 255, 255]);
		expect(hub.receive(stray, garbage)).toBe(false);
		expect(attrs(laptop.document)).toEqual({ a: 1 });
	});

	test('a socket that left is a socket whose bytes go nowhere', async () => {
		const phone = await device();
		const laptop = await device();
		const gone: DocumentSocket = { send: () => undefined };
		hub.join(gone);
		hub.leave(gone);

		expect(
			hub.receive(
				gone,
				new Uint8Array([0, ...Y.encodeStateVector(phone.document)]),
			),
		).toBe(false);
		expect(attrs(laptop.document)).toEqual({});
	});
});

describe('durability, across the whole stack', () => {
	test('what a device persisted is there before it ever attaches again', async () => {
		const phone = await device();
		const laptop = await device();
		write(laptop.document, 'fromLaptop', 1);
		laptop.session.flush();
		await phone.persist();

		// The authority holds it, and so does the phone's own blob.
		const fresh = new Y.Doc({ gc: true });
		Y.applyUpdateV2(fresh, authority.since(Y.encodeStateVector(fresh)));
		expect(fresh.get('notes').getAttrs()).toEqual({ fromLaptop: 1 });
		expect(attrs(phone.document)).toEqual({ fromLaptop: 1 });
	});
});
