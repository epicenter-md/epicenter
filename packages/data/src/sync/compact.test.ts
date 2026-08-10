/**
 * The reclaim walk and the compact client, against real stores and a
 * scripted authority.
 *
 * The walk's claims are the expensive ones (ADR-0231 calls it the one part
 * that is real engineering), so they are asserted on full store round-trips:
 * same rows, same ids, same prose with its marks, and a struct count that
 * actually fell. The client's claims are about the lease: a compact built on
 * a moved log is refused, a contested boundary resolves into adoption, and a
 * crash-replay can never publish twice.
 */
import { describe, expect, test } from 'bun:test';
import { defineLens } from '@epicenter/lens';
import type { Result } from 'wellcrafted/result';

import { openMemory } from '../store/bun.js';
import type { ApplicationOf } from '../store/store.js';
import {
	compactStore,
	type RebornState,
	readBoundary,
	rebirth,
	type StoreTransport,
} from './compact.js';

const lens = defineLens({
	namespace: 'so.epicenter.compact',
	kv: { theme: "'light'|'dark' = 'light'" },
	tables: { notes: { title: 'string' } },
});

function expectOk<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (result.error !== null) throw result.error;
	return result.data as TValue;
}

/**
 * A store that has lived: a rolling window of rows with prose, so creations,
 * edits and deletions INTERLEAVE. The interleaving is load-bearing for the
 * struct-count assertion: contiguous dead ranges merge into one GC struct,
 * while real churn leaves skeletons that cannot merge, which is the dead
 * weight ADR-0219 priced at about two items per deleted row.
 */
function agedApplication(): ApplicationOf<typeof lens> {
	const app = openMemory(lens);
	const keep: string[] = [];
	for (let index = 0; index < 100; index += 1) {
		const row = expectOk(
			app.tables.notes.create(
				{ title: `note ${index}` },
				{ document: ['body'] },
			),
		);
		const body = app.tables.notes.document(row.id)?.get('body', 'text');
		if (body === undefined) throw new Error('the row has no document');
		body.applyDelta(body.change.insert('plain ') as never);
		body.applyDelta(
			body.change.retain(6).insert('bold', { bold: true }) as never,
		);
		keep.push(row.id);
		// Touch an older survivor so clock ranges interleave.
		const older = keep[Math.max(0, keep.length - 3)] as string;
		expectOk(app.tables.notes.update(older, { title: `touched ${index}` }));
		if (keep.length > 10) {
			expectOk(app.tables.notes.delete(keep.shift() as string));
		}
	}
	expectOk(app.kv.update({ theme: 'dark' }));
	return app;
}

describe('rebirth re-encodes the live state into new identities (ADR-0231)', () => {
	test('same rows, same ids, same kv, same prose and marks', () => {
		const source = agedApplication();
		const reborn = expectOk(rebirth(source.store));

		const adopted = openMemory(lens);
		expectOk(adopted.store.applyRemote(reborn));

		const before = expectOk(source.tables.notes.list()).rows;
		const after = expectOk(adopted.tables.notes.list()).rows;
		expect(after).toEqual(before);
		expect(after.length).toBe(10);
		expect(expectOk(adopted.kv.get())).toEqual(expectOk(source.kv.get()));

		for (const row of before) {
			const original = source.tables.notes
				.document(row.id)
				?.get('body', 'text');
			const copied = adopted.tables.notes.document(row.id)?.get('body', 'text');
			if (original === undefined || copied === undefined) {
				throw new Error('a row lost its document');
			}
			// Deep deltas rather than toJSON, because a shallow comparison passes
			// while silently dropping every formatting mark.
			expect(JSON.stringify(copied.toDeltaDeep())).toBe(
				JSON.stringify(original.toDeltaDeep()),
			);
			expect(JSON.stringify(copied.toDeltaDeep())).toContain('"bold":true');
		}
	});

	test('the tombstones are actually gone: the struct count falls', () => {
		const source = agedApplication();
		const reborn = expectOk(rebirth(source.store));
		const adopted = openMemory(lens);
		expectOk(adopted.store.applyRemote(reborn));

		const agedItems = expectOk(source.store.pressure()).items;
		const rebornItems = expectOk(adopted.store.pressure()).items;
		expect(expectOk(adopted.store.pressure()).liveRows).toBe(
			expectOk(source.store.pressure()).liveRows,
		);
		// 90 deleted rows of interleaved churn against 10 live rows.
		expect(rebornItems).toBeLessThan(agedItems / 3);
	});

	test('a replica holding unresolved dependencies is refused', () => {
		// Prose whose container never arrived: Yjs buffers it silently (a bare
		// clock gap integrates fine in @y/y 14; a missing PARENT struct is what
		// pends), and a state built over that hole must not become the baseline.
		const writer = openMemory(lens);
		const row = expectOk(
			writer.tables.notes.create({ title: 'base' }, { document: ['body'] }),
		);
		const body = writer.tables.notes.document(row.id)?.get('body', 'text');
		if (body === undefined) throw new Error('the row has no document');
		const beforeProse = writer.store.stateVector();
		body.applyDelta(body.change.insert('orphaned prose') as never);
		const increment = writer.store.encodeStateSince(beforeProse);

		const receiver = openMemory(lens);
		expectOk(receiver.store.applyRemote(increment));
		expect(receiver.store.hasUnresolvedDependencies()).toBe(true);

		expect(rebirth(receiver.store).error?.name).toBe('UnresolvedDependencies');
	});

	test('the brand separates reborn bytes from a plain re-encoding', () => {
		const app = openMemory(lens);
		// @ts-expect-error encodeStateSince preserves identities and reclaims
		// nothing; only rebirth() mints RebornState (ADR-0231).
		const wrong: RebornState = app.store.encodeStateSince();
		expect(wrong).toBeInstanceOf(Uint8Array);
	});
});

/** A scripted authority door: what the probe and the verb answer, per call. */
function scriptedTransport(script: {
	probe?: () => Response | Promise<Response>;
	replace?: (url: URL) => Response;
}) {
	const probes: number[] = [];
	const replaces: URL[] = [];
	const transport: StoreTransport = {
		baseURL: 'https://api.example.com',
		namespace: lens.namespace,
		fetch: async (input, init) => {
			const url = new URL(input);
			if (init?.method === 'POST') {
				replaces.push(url);
				if (script.replace === undefined) throw new Error('unexpected POST');
				return script.replace(url);
			}
			probes.push(1);
			if (script.probe === undefined) throw new Error('unexpected probe');
			return script.probe();
		},
	};
	return { transport, probes, replaces };
}

/** A store with a cursor, which is what the lease is built from. */
function syncedApplication(cursor: number) {
	const app = openMemory(lens);
	expectOk(app.tables.notes.create({ title: 'kept across compaction' }));
	if (cursor > 0) expectOk(app.store.sync.advance(cursor));
	return app;
}

describe('compactStore holds the lease honestly', () => {
	test('publishes with atHead = its own cursor and fromBoundary from the probe', async () => {
		const app = syncedApplication(7);
		const { transport, replaces } = scriptedTransport({
			probe: () => Response.json({ boundary: 3 }),
			replace: () => Response.json({ boundary: 8 }),
		});

		const published = await compactStore({ store: app.store, transport });

		expect(expectOk(published)).toEqual({ boundary: 8 });
		expect(replaces).toHaveLength(1);
		const url = replaces[0] as URL;
		expect(url.searchParams.get('fromBoundary')).toBe('3');
		expect(url.searchParams.get('atHead')).toBe('7');
		expect(url.searchParams.get('namespace')).toBe(lens.namespace);
	});

	test('a CAS miss retries from the answered boundary, bounded', async () => {
		const app = syncedApplication(7);
		let posts = 0;
		const { transport, replaces } = scriptedTransport({
			probe: () => Response.json({ boundary: 0 }),
			replace: () => {
				posts += 1;
				return posts === 1
					? Response.json({ refused: 'boundary', boundary: 4 }, { status: 409 })
					: Response.json({ boundary: 8 });
			},
		});

		const published = await compactStore({ store: app.store, transport });

		expect(expectOk(published)).toEqual({ boundary: 8 });
		expect((replaces[1] as URL).searchParams.get('fromBoundary')).toBe('4');
	});

	test('a moved log refuses the compact: sync, then try again', async () => {
		const app = syncedApplication(7);
		const { transport } = scriptedTransport({
			probe: () => Response.json({ boundary: 0 }),
			replace: () =>
				Response.json({ refused: 'head', head: 9 }, { status: 409 }),
		});

		const refused = await compactStore({ store: app.store, transport });

		expect(refused.error?.name).toBe('StoreChanged');
		expect(
			refused.error?.name === 'StoreChanged' ? refused.error.head : -1,
		).toBe(9);
	});

	test('an unreadable boundary posts nothing at all', async () => {
		// The same never-on-doubt posture as the supersession rule: unknown
		// does nothing, and especially does not publish.
		const app = syncedApplication(7);
		const { transport, replaces } = scriptedTransport({
			probe: () => Response.json('not a boundary shape'),
		});

		const refused = await compactStore({ store: app.store, transport });

		expect(refused.error?.name).toBe('BoundaryUnreadable');
		expect(replaces).toHaveLength(0);
	});

	test('a crash-replay of a compact that landed can never publish twice', async () => {
		// The first attempt published boundary 8 and the device died before
		// discarding. On replay its cursor is still 7, the probe answers the
		// new boundary, and the lease refuses: head is 8, atHead is 7. The
		// replica falls into ordinary adoption; nothing is republished.
		const app = syncedApplication(7);
		const { transport, replaces } = scriptedTransport({
			probe: () => Response.json({ boundary: 8 }),
			replace: (url) => {
				expect(url.searchParams.get('atHead')).toBe('7');
				return Response.json({ refused: 'head', head: 8 }, { status: 409 });
			},
		});

		const replayed = await compactStore({ store: app.store, transport });

		expect(replayed.error?.name).toBe('StoreChanged');
		expect(replaces).toHaveLength(1);
	});

	test('a boundary contested through every retry resolves into adoption', async () => {
		const app = syncedApplication(7);
		let boundary = 10;
		const { transport, replaces } = scriptedTransport({
			probe: () => Response.json({ boundary: 0 }),
			replace: () =>
				Response.json(
					{ refused: 'boundary', boundary: (boundary += 1) },
					{ status: 409 },
				),
		});

		const contested = await compactStore({ store: app.store, transport });

		expect(contested.error?.name).toBe('Contested');
		expect(replaces).toHaveLength(3);
	});
});

describe('readBoundary answers only with a well-formed boundary', () => {
	test('a boundary is a number, and anything else is unreadable', async () => {
		const answers: [() => Response, 'ok' | 'BoundaryUnreadable'][] = [
			[() => Response.json({ boundary: 4 }), 'ok'],
			[() => Response.json({}), 'BoundaryUnreadable'],
			[() => Response.json({ boundary: 'four' }), 'BoundaryUnreadable'],
			[() => new Response('nope', { status: 500 }), 'BoundaryUnreadable'],
		];
		for (const [probe, expected] of answers) {
			const { transport } = scriptedTransport({ probe });
			const read = await readBoundary(transport);
			if (expected === 'ok') expect(expectOk(read)).toBe(4);
			else expect(read.error?.name).toBe(expected);
		}
	});
});
