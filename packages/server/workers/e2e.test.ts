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
 * through its lens out of its own SQLite, never on a count this file kept. A
 * rule on this branch once "worked" in a simulation that delivered nothing.
 *
 * And the isolation that gives the claim its meaning: a device on a DIFFERENT
 * principal must see nothing. Without it, "the note arrived" is also what a
 * single shared authority looks like, which would be a data leak rather than a
 * feature.
 */
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { STORE_REPLACE_ROUTE } from '@epicenter/sync';
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';

import type { ReplicaReport, StoreTestReplica } from './replica.js';

const ORIGIN = 'http://example.com';
const NAMESPACE = 'so.epicenter.storeprobe';

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
				open: () =>
					inside((replica) => replica.open(`device:${principal}`, ORIGIN)),
				write: (title: string, prose: string) =>
					inside((replica) => replica.write(title, prose)),
				report: (): Promise<ReplicaReport> =>
					inside((replica) => replica.report()),
				encodeState: (): Promise<Uint8Array> =>
					inside((replica) => replica.encodeState()),
			};
		},
	};
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
				`${ORIGIN}/api/store/v1/sync?namespace=so.epicenter.storeprobe&cursor=0`,
				{
					headers: { Upgrade: 'websocket' },
				},
			),
		);
		expect(response.status).toBe(401);
	});

	it('a namespace no Lens could declare is refused', async () => {
		const response = await SELF.fetch(
			new Request(`${ORIGIN}/api/store/v1/sync?namespace=../escape&cursor=0`, {
				headers: {
					Upgrade: 'websocket',
					'sec-websocket-protocol': 'epicenter, bearer.device:someone',
				},
			}),
		);
		expect(response.status).toBe(400);
	});
});

describe('one verb publishes the next edition (ADR-0231)', () => {
	/** The person-initiated POST, built by the same helper a real caller uses. */
	function postReplace(
		account: string,
		params: { fromBoundary: number; atHead?: number },
		body: Uint8Array,
	): Promise<Response> {
		return SELF.fetch(
			new Request(
				STORE_REPLACE_ROUTE.url(ORIGIN, { namespace: NAMESPACE, ...params }),
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
	function dial(account: string, cursor: number): Promise<Response> {
		return SELF.fetch(
			new Request(
				`${ORIGIN}/api/store/v1/sync?namespace=${NAMESPACE}&cursor=${cursor}`,
				{
					headers: {
						Upgrade: 'websocket',
						'sec-websocket-protocol': `epicenter, bearer.device:${account}`,
					},
				},
			),
		);
	}

	it('a stale cursor is refused before any socket exists, and a zero cursor still joins', async () => {
		const vault = openAccount('edition');
		const phone = vault.device('phone');
		await phone.open();
		await phone.write('Old', 'retired prose');
		await until(
			'the phone to sync its note',
			async () => (await phone.report()).cursor > 0,
		);
		const staleCursor = (await phone.report()).cursor;

		const published = await postReplace(
			vault.account,
			{ fromBoundary: 0 },
			emptyState(),
		);
		expect(published.status).toBe(200);
		const { boundary } = (await published.json()) as { boundary: number };
		expect(boundary).toBeGreaterThan(staleCursor);

		// The funeral notice: refused at the door, with no socket ever made.
		// `webSocket` is `null` on a non-101 in workerd, never a socket.
		const refused = await dial(vault.account, staleCursor);
		expect(refused.status).toBe(409);
		expect(
			(refused as unknown as { webSocket: WebSocket | null }).webSocket,
		).toBeNull();
		expect(await refused.json()).toEqual({ boundary });

		// Zero holds no commitment: the unsynced offline install is greeted.
		const greeted = await dial(vault.account, 0);
		expect(greeted.status).toBe(101);
		const socket = (greeted as unknown as { webSocket?: WebSocket }).webSocket;
		expect(socket).toBeDefined();
		socket?.accept();
		socket?.close();

		// And so is a cursor already inside the new edition.
		const current = await dial(vault.account, boundary);
		expect(current.status).toBe(101);
		const currentSocket = (current as unknown as { webSocket?: WebSocket })
			.webSocket;
		currentSocket?.accept();
		currentSocket?.close();
	});

	it('a superseded device cannot reintroduce retired history, and a fresh join sees only the replacement', async () => {
		const vault = openAccount('funeral');
		const phone = vault.device('phone');
		await phone.open();
		await phone.write('Old', 'not to be republished');
		await until(
			'the phone to sync its note',
			async () => (await phone.report()).cursor > 0,
		);

		const published = await postReplace(
			vault.account,
			{ fromBoundary: 0 },
			emptyState(),
		);
		expect(published.status).toBe(200);

		// A device that was never part of the old edition joins at zero and gets
		// the replacement: an empty application.
		const tablet = vault.device('tablet');
		await tablet.open();
		await until(
			'the tablet to adopt the new edition',
			async () => (await tablet.report()).cursor > 0,
		);
		expect((await tablet.report()).titles).toEqual([]);

		// The phone's socket was closed by the replace; its driver redials on
		// backoff and is refused every time. Long enough that a republication
		// would have arrived: its own note once crossed in far less.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect((await tablet.report()).titles).toEqual([]);
		// Never silently destroyed: the phone keeps working locally, holding what
		// it holds, until a person runs its funeral at boot.
		const stranded = await phone.report();
		expect(stranded.titles).toEqual(['Old']);
		expect(stranded.connected).toBe(false);
	});

	it('the lease over HTTP: fromBoundary is CAS, atHead refuses a moved tail, and a reclaim republishes the same data', async () => {
		const vault = openAccount('lease');
		const phone = vault.device('phone');
		await phone.open();
		await phone.write('Seed', 'first edition');
		await until(
			'the phone to sync its note',
			async () => (await phone.report()).cursor > 0,
		);

		const reset = await postReplace(
			vault.account,
			{ fromBoundary: 0 },
			emptyState(),
		);
		expect(reset.status).toBe(200);
		const { boundary } = (await reset.json()) as { boundary: number };

		// A retry whose first attempt landed, or the loser of a concurrent pair:
		// the CAS misses and the answer names the current boundary.
		const missed = await postReplace(
			vault.account,
			{ fromBoundary: 0 },
			emptyState(),
		);
		expect(missed.status).toBe(409);
		expect(await missed.json()).toEqual({ refused: 'boundary', boundary });

		// New edition, new work: a fresh device adopts and writes.
		const tablet = vault.device('tablet');
		await tablet.open();
		await until('the tablet to adopt and sync a write', async () => {
			const report = await tablet.report();
			if (report.cursor === boundary)
				await tablet.write('New', 'kept across reclaim');
			return report.cursor > boundary;
		});

		// Reclaim promises "same data", so a lease built at the boundary is
		// refused once the tail has moved past it.
		const expired = await postReplace(
			vault.account,
			{ fromBoundary: boundary, atHead: boundary },
			await tablet.encodeState(),
		);
		expect(expired.status).toBe(409);
		const expiry = (await expired.json()) as { refused: string; head: number };
		expect(expiry.refused).toBe('head');
		expect(expiry.head).toBeGreaterThan(boundary);

		// The refused caller retries from what the refusal named, which is the
		// whole protocol: rebuild at the head you are told, post again.
		let lease = { fromBoundary: boundary, atHead: expiry.head };
		let republished: { boundary: number } | undefined;
		for (
			let attempt = 0;
			attempt < 10 && republished === undefined;
			attempt += 1
		) {
			const response = await postReplace(
				vault.account,
				lease,
				await tablet.encodeState(),
			);
			if (response.status === 200) {
				republished = (await response.json()) as { boundary: number };
				break;
			}
			const answer = (await response.json()) as {
				refused: string;
				boundary?: number;
				head?: number;
			};
			lease = {
				fromBoundary: answer.boundary ?? lease.fromBoundary,
				atHead: answer.head ?? lease.atHead,
			};
		}
		if (republished === undefined) throw new Error('the reclaim never landed');

		// A third device joins the third edition and sees the reclaimed data:
		// same rows, none of the retired history.
		const laptop = vault.device('laptop');
		await laptop.open();
		await until(
			'the laptop to adopt the reclaimed edition',
			async () => (await laptop.report()).titles.length > 0,
		);
		const adopted = await laptop.report();
		expect(adopted.titles).toEqual(['New']);
		expect(adopted.cursor).toBe(republished.boundary);
		expect(adopted.lastError).toBeUndefined();
	});

	it('a replace with no body is refused: an encoded empty document is still bytes', async () => {
		// The edition an empty body would publish is one no replica could adopt;
		// a reset posts `emptyState()`, never nothing.
		const vault = openAccount('emptybody');
		const refused = await postReplace(
			vault.account,
			{ fromBoundary: 0 },
			new Uint8Array(0),
		);
		expect(refused.status).toBe(400);
	});
});
