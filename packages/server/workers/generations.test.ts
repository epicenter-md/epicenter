/**
 * The generations collection, against the DEPLOYED routes inside `workerd`.
 *
 * The half of ADR-0292 and ADR-0293 that no in-process test can reach: a
 * generation is created by one authenticated request whose body is a whole
 * database state, it exists if and only if the ledger says so, and a second
 * device fetches it back byte for byte with the position it is current
 * through.
 *
 * The controls that give the claim meaning: a number nobody imported is a 404
 * rather than an empty database, and a device on another principal sees none
 * of it. Without the second one, "the state came back" is also what a single
 * shared object looks like.
 */
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const ORIGIN = 'http://example.com';
const DATA_ID = 'so.epicenter.storeprobe';

/** Deterministic bytes that are not a Yjs update by any decoding. */
function opaque(seed: number, length = 64): Uint8Array {
	return Uint8Array.from({ length }, (_, i) => (seed * 31 + i * 7 + 255) % 256);
}

function request(
	principal: string,
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return SELF.fetch(`${ORIGIN}${path}`, {
		...init,
		headers: {
			authorization: `Bearer device:${principal}`,
			...(init?.headers ?? {}),
		},
	});
}

const collection = `/api/data/v1/${DATA_ID}/generations`;

describe('a generation is created by importing a whole state', () => {
	it('assigns a number, serves the bytes back, and lists what exists', async () => {
		const principal = `import-${crypto.randomUUID()}`;
		const state = opaque(1);

		// Nothing exists before the import.
		const empty = await request(principal, collection);
		expect(empty.status).toBe(200);
		expect(await empty.json()).toEqual({ generations: [] });

		const created = await request(principal, collection, {
			method: 'POST',
			body: state as unknown as BodyInit,
		});
		expect(created.status).toBe(200);
		const { generation, position } = (await created.json()) as {
			generation: number;
			position: number;
		};
		// The client never chooses the number, and the first one is 1.
		expect(generation).toBe(1);
		// The position the state is current through, which is what makes the
		// bootstrap worth making: the socket carries only what came after it.
		expect(position).toBe(1);

		// Served verbatim. The authority stored it whole and never interpreted a
		// field, so what comes back is byte for byte what went in.
		const fetched = await request(principal, `${collection}/${generation}`);
		expect(fetched.status).toBe(200);
		expect(fetched.headers.get('epicenter-log-position')).toBe('1');
		expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(state);

		const listed = await request(principal, collection);
		expect(await listed.json()).toEqual({ generations: [1] });
	});

	it('numbers are monotonic and a second import is a second generation', async () => {
		const principal = `second-${crypto.randomUUID()}`;
		const first = (await (
			await request(principal, collection, {
				method: 'POST',
				body: opaque(2) as unknown as BodyInit,
			})
		).json()) as { generation: number };
		const second = (await (
			await request(principal, collection, {
				method: 'POST',
				body: opaque(3) as unknown as BodyInit,
			})
		).json()) as { generation: number };
		expect([first.generation, second.generation]).toEqual([1, 2]);

		// And they are two objects: the first still holds what it was imported
		// with, because a generation is never mutated in place.
		const back = await request(principal, `${collection}/1`);
		expect(new Uint8Array(await back.arrayBuffer())).toEqual(opaque(2));
		expect(await (await request(principal, collection)).json()).toEqual({
			generations: [1, 2],
		});
	});

	it('a number nobody imported is not found, and never allocated', async () => {
		const principal = `missing-${crypto.randomUUID()}`;
		// The whole reason opening is cache-first with an explicit miss: a
		// number in a URL is an address, not an instruction to allocate.
		expect((await request(principal, `${collection}/7`)).status).toBe(404);
		expect(await (await request(principal, collection)).json()).toEqual({
			generations: [],
		});
	});

	it('a generation belongs to one principal and no other', async () => {
		const mine = `mine-${crypto.randomUUID()}`;
		const theirs = `theirs-${crypto.randomUUID()}`;
		await request(mine, collection, {
			method: 'POST',
			body: opaque(4) as unknown as BodyInit,
		});

		// The principal is stamped from the resolved bearer and prefixed onto
		// the object name, so there is no value another signed-in device can
		// write into a URL that reaches this data.
		expect((await request(theirs, `${collection}/1`)).status).toBe(404);
		expect(await (await request(theirs, collection)).json()).toEqual({
			generations: [],
		});
	});

	it('an empty body is refused rather than creating an empty generation', async () => {
		const principal = `emptybody-${crypto.randomUUID()}`;
		const refused = await request(principal, collection, {
			method: 'POST',
			body: new Uint8Array(0) as unknown as BodyInit,
		});
		expect(refused.status).toBe(400);
		expect(await (await request(principal, collection)).json()).toEqual({
			generations: [],
		});
	});

	it('an unauthenticated request reaches nothing', async () => {
		const anonymous = await SELF.fetch(`${ORIGIN}${collection}`);
		expect(anonymous.status).toBe(401);
	});
});
