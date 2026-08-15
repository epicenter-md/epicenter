/**
 * Two signed-in devices, one account, one note crossing between them.
 *
 * The claim the whole store transport exists to make, asserted against the
 * DEPLOYED route and the DEPLOYED Durable Object inside real `workerd`. The one
 * substitution is the bearer resolver; Better Auth is tested elsewhere and is
 * not what this adds.
 *
 * ## The controls
 *
 * Convergence is asserted on the RECEIVING replica's own rows, read back
 * through its workspace out of its own SQLite, never on a count this file kept. A
 * rule on this branch once "worked" in a simulation that delivered nothing.
 *
 * And the isolation that gives the claim its meaning: a device on a DIFFERENT
 * principal must see nothing. Without it, "the note arrived" is also what a
 * single shared authority looks like, which would be a data leak rather than a
 * feature.
 */
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { decodeFrame, type Frame } from '@epicenter/data/sync';
import { STORE_REPLACE_ROUTE } from '@epicenter/sync';
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';

import type { ReplicaReport, StoreTestReplica } from './replica.js';

const ORIGIN = 'http://example.com';
const WORKSPACE_ID = 'so.epicenter.storeprobe';

type Replicas = ReturnType<typeof openAccount>;

function openAccount(label: string) {
	const account = `${label}-${crypto.randomUUID()}`;
	return {
		account,
		/**
		 * One device of this account, or of another when `principal` says so.
		 *
		 * The principal is what the bearer resolves to, and it is the ONLY thing
		 * that decides which authority this device reaches. Nothing else here can
		 * express "whose data".
		 */
		device(name: string, principal = account) {
			const stub = env.REPLICA.get(
				env.REPLICA.idFromName(`${account}-${name}`),
			);
			// `runInDurableObject` widens the instance to the base `DurableObject`,
			// so the concrete class is named here rather than reached for through
			// the stub's own generic.
			const inside = <TValue>(
				run: (replica: StoreTestReplica) => TValue,
			): Promise<TValue> =>
				runInDurableObject(stub, (replica) =>
					run(replica as unknown as StoreTestReplica),
				);
			return {
				open: (options?: { connect?: boolean }) =>
					inside((replica) =>
						replica.open(`device:${principal}`, ORIGIN, options),
					),
				startSync: () => inside((replica) => replica.startSync()),
				stopSync: () => inside((replica) => replica.stopSync()),
				rebuild: () => inside((replica) => replica.rebuild()),
				write: (title: string, prose: string) =>
					inside((replica) => replica.write(title, prose)),
				remove: (title: string) => inside((replica) => replica.remove(title)),
				report: (): Promise<ReplicaReport> =>
					inside((replica) => replica.report()),
				encodeState: (): Promise<Uint8Array> =>
					inside((replica) => replica.encodeState()),
			};
		},
	};
}

/**
 * The boot gate, test-shaped (ADR-0231): a signed-in workspace that has never
 * downloaded is unavailable until its first bootstrap binds it, so a device
 * writes only once bound. Writing earlier authors work no authority document
 * owns, and first contact discards it; the STATED LOSS test asserts that
 * deliberately, and every other test binds before writing.
 */
async function bound(device: {
	report(): Promise<ReplicaReport>;
}): Promise<void> {
	await until(
		'the device to bind to the authority document',
		async () => (await device.report()).document !== undefined,
	);
}

/** Poll until `check` holds, or fail loudly rather than hang. */
async function until(
	label: string,
	check: () => Promise<boolean>,
	timeoutMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline)
			throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe('two devices on one account converge', () => {
	it('a note written on the phone arrives on the laptop, with its prose', async () => {
		const vault: Replicas = openAccount('converge');
		const phone = vault.device('phone');
		const laptop = vault.device('laptop');
		await phone.open();
		await laptop.open();
		await bound(phone);

		await phone.write('Groceries', 'milk and eggs');

		await until('the laptop to hold the note', async () => {
			const report = await laptop.report();
			return report.titles.includes('Groceries');
		});

		const arrived = await laptop.report();
		expect(arrived.titles).toEqual(['Groceries']);
		expect(arrived.prose.join(' ')).toContain('milk and eggs');
		expect(arrived.lastError).toBeUndefined();
	});

	it('CONTROL: a device on another account sees nothing', async () => {
		// The isolation that makes the test above a feature rather than a leak.
		// Same route, same worker, same Durable Object class; only the bearer
		// differs, and the authority is addressed by the principal it resolves to.
		const vault = openAccount('isolation');
		const mine = vault.device('mine');
		const stranger = vault.device(
			'stranger',
			`someone-else-${crypto.randomUUID()}`,
		);
		await mine.open();
		await stranger.open();
		await bound(mine);

		await mine.write('Private', 'not for you');
		await until('my own device to hold it', async () =>
			(await mine.report()).titles.includes('Private'),
		);
		// Long enough that a leak would have arrived: the writer's own copy has
		// already round-tripped through the authority by now.
		await new Promise((resolve) => setTimeout(resolve, 500));

		expect((await stranger.report()).titles).toEqual([]);
	});

	it('both directions, and a third device catches up on arrival', async () => {
		const vault = openAccount('catchup');
		const phone = vault.device('phone');
		const laptop = vault.device('laptop');
		await phone.open();
		await laptop.open();
		await bound(phone);
		await bound(laptop);

		await phone.write('from the phone', 'one');
		await laptop.write('from the laptop', 'two');
		await until('both devices to hold both notes', async () => {
			const [a, b] = await Promise.all([phone.report(), laptop.report()]);
			return a.titles.length === 2 && b.titles.length === 2;
		});

		// A device that was never connected while any of that happened gets it all
		// from the authority's log when it first dials, which is the same catch-up
		// a returning device runs.
		const tablet = vault.device('tablet');
		await tablet.open();
		await until(
			'the tablet to catch up',
			async () => (await tablet.report()).titles.length === 2,
		);

		expect((await tablet.report()).titles).toEqual([
			'from the laptop',
			'from the phone',
		]);
	});

	it('an upgrade with no bearer is refused', async () => {
		const response = await SELF.fetch(
			new Request(
				`${ORIGIN}/api/store/v1/sync?workspaceId=so.epicenter.storeprobe&cursor=0`,
				{
					headers: { Upgrade: 'websocket' },
				},
			),
		);
		expect(response.status).toBe(401);
	});

	it('a workspaceId no workspace could declare is refused', async () => {
		const response = await SELF.fetch(
			new Request(
				`${ORIGIN}/api/store/v1/sync?workspaceId=../escape&cursor=0`,
				{
					headers: {
						Upgrade: 'websocket',
						'sec-websocket-protocol': 'epicenter, bearer.device:someone',
					},
				},
			),
		);
		expect(response.status).toBe(400);
	});
});

describe('one verb publishes the next document (ADR-0231)', () => {
	/** The person-initiated POST, built by the same helper a real caller uses. */
	function postReplace(
		account: string,
		params: { fromDocument: string; atHead?: number },
		body: Uint8Array,
	): Promise<Response> {
		return SELF.fetch(
			new Request(
				STORE_REPLACE_ROUTE.url(ORIGIN, {
					workspaceId: WORKSPACE_ID,
					...params,
				}),
				{
					method: 'POST',
					headers: { authorization: `Bearer device:${account}` },
					// A fresh copy: the RPC boundary hands back a view whose buffer a
					// fetch body cannot always adopt.
					body: new Uint8Array(body),
				},
			),
		);
	}

	/** An encoded empty document: the argument of `replace(empty)`, a reset. */
	const emptyState = () =>
		new Uint8Array(Y.encodeStateAsUpdateV2(new Y.Doc({ gc: true })));

	/** Dial the sync route directly, so the refusal is visible as a response. */
	function dial(
		account: string,
		cursor: number,
		document?: string,
	): Promise<Response> {
		const declared =
			document === undefined ? '' : `&document=${encodeURIComponent(document)}`;
		return SELF.fetch(
			new Request(
				`${ORIGIN}/api/store/v1/sync?workspaceId=${WORKSPACE_ID}&cursor=${cursor}${declared}`,
				{
					headers: {
						Upgrade: 'websocket',
						'sec-websocket-protocol': `epicenter, bearer.device:${account}`,
					},
				},
			),
		);
	}

	/** Collect every frame a dial is sent until its socket closes. */
	async function framesUntilClose(response: Response): Promise<Frame[]> {
		const socket = (response as unknown as { webSocket: WebSocket | null })
			.webSocket;
		if (socket === null) throw new Error('the upgrade produced no socket');
		const received: Frame[] = [];
		const done = new Promise<void>((resolve) => {
			socket.addEventListener('close', () => resolve());
		});
		socket.accept();
		socket.addEventListener('message', (event) => {
			if (typeof event.data === 'string') return;
			const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
			if (frame.error === null) received.push(frame.data);
		});
		await done;
		return received;
	}

	it('a replica of a replaced document receives exactly the announcement, and is never served history', async () => {
		const vault = openAccount('document');
		const phone = vault.device('phone');
		await phone.open();
		await bound(phone);
		await phone.write('Old', 'retired prose');
		await until(
			'the phone to sync its note',
			async () => (await phone.report()).cursor > 0,
		);
		const stale = await phone.report();
		if (stale.document === undefined)
			throw new Error('the phone never stamped');

		const published = await postReplace(
			vault.account,
			{ fromDocument: stale.document },
			emptyState(),
		);
		expect(published.status).toBe(200);
		const { document: next } = (await published.json()) as {
			document: string;
		};
		expect(next).not.toBe(stale.document);

		// Connecting is not admission: the upgrade succeeds, because a browser
		// can read a frame and cannot read a refused handshake. What arrives is
		// the announcement, and nothing else, ever: no snapshot, no entries.
		const retired = await framesUntilClose(
			await dial(vault.account, stale.cursor, stale.document),
		);
		expect(retired).toEqual([{ kind: 'document', id: next }]);

		// An undeclared nonzero cursor is the former protocol, and the clean
		// break refuses it the same way: announced, never served.
		const undeclared = await framesUntilClose(
			await dial(vault.account, stale.cursor),
		);
		expect(undeclared).toEqual([{ kind: 'document', id: next }]);

		// A fresh install is greeted with the announcement and nothing else:
		// bootstrap is announce-only, so no history moves before the replica
		// has durably stamped the id it will declare.
		const greeted = await framesUntilClose(await dial(vault.account, 0));
		expect(greeted).toEqual([{ kind: 'document', id: next }]);

		// The redial through the equality door is admitted, and only THERE is
		// history served: the announcement again, then the snapshot.
		const admitted = await dial(vault.account, 0, next);
		expect(admitted.status).toBe(101);
		const member = (admitted as unknown as { webSocket?: WebSocket }).webSocket;
		if (member === undefined || member === null) {
			throw new Error('the admitted join produced no socket');
		}
		const greeting = new Promise<Frame[]>((resolve) => {
			const frames: Frame[] = [];
			member.addEventListener('message', (event) => {
				if (typeof event.data === 'string') return;
				const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
				if (frame.error !== null) return;
				frames.push(frame.data);
				if (frames.length === 2) resolve(frames);
			});
		});
		member.accept();
		const [name, history] = await greeting;
		expect(name).toEqual({ kind: 'document', id: next });
		expect(history?.kind).toBe('snapshot');
		member.close();
	});

	it('authority wins: a superseded device discards on its own and resyncs to the replacement', async () => {
		const vault = openAccount('adoption');
		const phone = vault.device('phone');
		await phone.open();
		await bound(phone);
		await phone.write('Old', 'not to be republished');
		await until(
			'the phone to sync its note',
			async () => (await phone.report()).cursor > 0,
		);

		const stamped = (await phone.report()).document;
		if (stamped === undefined) throw new Error('the phone never stamped');
		const published = await postReplace(
			vault.account,
			{ fromDocument: stamped },
			emptyState(),
		);
		expect(published.status).toBe(200);

		// The phone's socket was closed by the replace. Its next dial connects,
		// meets a document that is not its own, and runs the one adoption path:
		// discard whole, boot fresh, join at zero.
		await until('the phone to discard and adopt', async () => {
			const report = await phone.report();
			return report.adoptions >= 1 && report.cursor > 0;
		});
		expect((await phone.report()).titles).toEqual([]);

		// And nothing was republished: a fresh device sees only the replacement,
		// well after the phone's old copy would have crossed.
		const tablet = vault.device('tablet');
		await tablet.open();
		await until(
			'the tablet to adopt the new document',
			async () => (await tablet.report()).cursor > 0,
		);
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect((await tablet.report()).titles).toEqual([]);
	});

	it('rebuild: one device rebuilds, every synced device adopts, tombstones are reclaimed, marks survive', async () => {
		const vault = openAccount('rebuild');
		const phone = vault.device('phone');
		const laptop = vault.device('laptop');
		await phone.open();
		await laptop.open();
		await bound(phone);

		await phone.write('SECRET-CANARY-deleted', 'gone before the rebuild');
		await phone.write('kept', 'prose that survives');
		await until('both devices to hold both notes', async () => {
			const [a, b] = await Promise.all([phone.report(), laptop.report()]);
			return a.titles.length === 2 && b.titles.length === 2;
		});
		// Retire the canary, then let the deletion cross: the aged document now
		// carries tombstones that only a rebuild reclaims.
		await phone.remove('SECRET-CANARY-deleted');
		await until(
			'the deletion to cross',
			async () => (await laptop.report()).titles.length === 1,
		);

		const staleItems = (await laptop.report()).items;
		const published = await phone.rebuild();
		expect(published.document.length).toBeGreaterThan(0);

		// The initiator adopted through the same move as everyone else. Cursor
		// too, not just the stamp: the announcement stamps the document before
		// the equality-door redial delivers the snapshot, and a report taken in
		// that window truthfully holds nothing yet.
		await until('the phone to rejoin the document it published', async () => {
			const report = await phone.report();
			return (
				report.adoptions >= 1 &&
				report.document === published.document &&
				report.cursor > 0
			);
		});
		// The laptop's socket was closed by the replace; it adopts on its own.
		await until('the laptop to discard and adopt', async () => {
			const report = await laptop.report();
			return (
				report.adoptions >= 1 &&
				report.document === published.document &&
				report.cursor > 0
			);
		});

		const [phoneAfter, laptopAfter] = await Promise.all([
			phone.report(),
			laptop.report(),
		]);
		expect(laptopAfter.titles).toEqual(phoneAfter.titles);
		expect(laptopAfter.prose).toEqual(phoneAfter.prose);
		expect(laptopAfter.prose.join(' ')).toContain('prose that survives');
		expect(laptopAfter.lastError).toBeUndefined();
		// Reborn means smaller: the adopted document dropped dead weight.
		expect(laptopAfter.items).toBeLessThanOrEqual(staleItems);
	});

	it('STATED LOSS: unpushed work of the old document and pre-bootstrap work are both discarded, never merged', async () => {
		// ADR-0231, asserted deliberately so the line stays a decision with a
		// warning at the verb rather than a rediscovered bug. Two kinds of
		// unsynced work meet a rebuild, and both are discarded: a device of the
		// OLD document loses its unpushed offline notes, and a device that
		// wrote before ever bootstrapping loses everything at first contact,
		// because bytes merge only when they name the same document and
		// promotion is never automatic.
		const vault = openAccount('statedloss');
		const phone = vault.device('phone');
		await phone.open();
		await bound(phone);
		await phone.write('kept', 'synced before the rebuild');
		await until(
			'the phone to sync its note',
			async () => (await phone.report()).cursor > 0,
		);

		// The drawer device: synced once, went offline, kept writing.
		const drawer = vault.device('drawer');
		await drawer.open();
		await until(
			'the drawer to join the old document',
			async () => (await drawer.report()).cursor > 0,
		);
		await drawer.stopSync();
		await drawer.write('unsynced offline note', 'nobody ever saw this');
		expect((await drawer.report()).titles).toContain('unsynced offline note');

		// The fresh install: offline work, but no cursor and no commitment.
		const fresh = vault.device('fresh');
		await fresh.open({ connect: false });
		await fresh.write('fresh install note', 'written before first sync');

		const published = await phone.rebuild();

		// The drawer returns into a retired document: announced, discard, adopt.
		// Its unpushed note is gone, per the warning the person rebuilding saw.
		await drawer.startSync();
		await until('the drawer to discard and adopt', async () => {
			const report = await drawer.report();
			return report.adoptions >= 1 && report.document === published.document;
		});
		const adopted = await drawer.report();
		expect(adopted.titles).toEqual(['kept']);
		expect(adopted.adoptions).toBe(1);

		// The fresh install wrote before ever bootstrapping, so its work
		// belongs to no authority document. First contact discards it, never
		// promotes it (ADR-0231): the device adopts the current document and
		// holds exactly what the authority does.
		await fresh.startSync();
		await until('the fresh install to discard and adopt', async () => {
			const report = await fresh.report();
			return (
				report.adoptions >= 1 &&
				report.document === published.document &&
				report.titles.length === 1
			);
		});
		expect((await fresh.report()).titles).toEqual(['kept']);

		// The titles nobody ever synced exist nowhere: the authority never
		// heard of them, and every replica converges without them.
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect((await phone.report()).titles).toEqual(['kept']);
	});

	it('the lease over HTTP: fromDocument is CAS, atHead refuses a moved tail, and a reclaim republishes the same data', async () => {
		const vault = openAccount('lease');
		const phone = vault.device('phone');
		await phone.open();
		await bound(phone);
		await phone.write('Seed', 'first document');
		await until(
			'the phone to sync its note',
			async () => (await phone.report()).cursor > 0,
		);
		const first = (await phone.report()).document;
		if (first === undefined) throw new Error('the phone never stamped');

		const reset = await postReplace(
			vault.account,
			{ fromDocument: first },
			emptyState(),
		);
		expect(reset.status).toBe(200);
		const { document: second } = (await reset.json()) as { document: string };

		// A retry whose first attempt landed, or the loser of a concurrent pair:
		// the CAS misses and the answer names the current document. No retry may
		// republish stale-built bytes over it.
		const missed = await postReplace(
			vault.account,
			{ fromDocument: first },
			emptyState(),
		);
		expect(missed.status).toBe(409);
		expect(await missed.json()).toEqual({
			refused: 'document',
			document: second,
		});

		// New document, new work: a fresh device adopts and writes.
		const tablet = vault.device('tablet');
		await tablet.open();
		await until('the tablet to adopt and sync a write', async () => {
			const report = await tablet.report();
			if (report.document === second && report.titles.length === 0) {
				await tablet.write('New', 'kept across reclaim');
			}
			return report.document === second && report.titles.length === 1;
		});
		await until(
			'the tablet write to land',
			async () => (await tablet.report()).cursor > 1,
		);
		const built = await tablet.report();

		// Reclaim promises "same data", so a lease built at a head the tail has
		// moved past is refused.
		const expired = await postReplace(
			vault.account,
			{ fromDocument: second, atHead: built.cursor + 5 },
			await tablet.encodeState(),
		);
		expect(expired.status).toBe(409);
		const expiry = (await expired.json()) as { refused: string; head: number };
		expect(expiry.refused).toBe('head');

		// The honest lease lands: the current document, at its real head.
		const landed = await postReplace(
			vault.account,
			{ fromDocument: second, atHead: expiry.head },
			await tablet.encodeState(),
		);
		expect(landed.status).toBe(200);
		const republished = (await landed.json()) as { document: string };
		expect(republished.document).not.toBe(second);

		// A third device joins the third document and sees the reclaimed data:
		// same rows, none of the retired history.
		const laptop = vault.device('laptop');
		await laptop.open();
		await until(
			'the laptop to adopt the reclaimed document',
			async () => (await laptop.report()).titles.length > 0,
		);
		const adopted = await laptop.report();
		expect(adopted.titles).toEqual(['New']);
		expect(adopted.document).toBe(republished.document);
		expect(adopted.lastError).toBeUndefined();
	});

	it('a replace with no body is refused: an encoded empty document is still bytes', async () => {
		// The document an empty body would publish is one no replica could
		// adopt; a reset posts `emptyState()`, never nothing.
		const vault = openAccount('emptybody');
		const refused = await postReplace(
			vault.account,
			{ fromDocument: 'anything' },
			new Uint8Array(0),
		);
		expect(refused.status).toBe(400);
	});
});
