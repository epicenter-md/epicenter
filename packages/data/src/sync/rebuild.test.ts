import { field } from '@epicenter/data/definition';
/**
 * The reclaim walk and the rebuild client, against real stores and a
 * scripted authority.
 *
 * The walk's claims are the expensive ones (ADR-0231 calls it the one part
 * that is real engineering), so they are asserted on full store round-trips:
 * same rows, same ids, same prose with its marks, and a struct count that
 * actually fell. The client's claims are about the lease: the post names the
 * document the replica is stamped into and the head its state covers, a
 * rebuild built on a moved log is refused, and a contested document resolves
 * into adoption, which is also why a crash-replay can never publish twice.
 */
import { describe, expect, test } from 'bun:test';
import { defineData } from '@epicenter/data/definition';
import type { Result } from 'wellcrafted/result';

import { openMemory } from '../store/bun.js';
import { encodeEnvelope } from '../store/envelope.js';
import { APP_DOCUMENT } from '../store/log.js';
import { type DataOf, syncEngineOf } from '../store/store.js';
import {
	type RebuiltState,
	rebuildDatabase,
	rebuildDocument,
	type StoreTransport,
} from './rebuild.js';

const database = defineData({
	id: 'so.epicenter.rebuild',
	kv: { theme: field.select(['light', 'dark']) },
	tables: { notes: { title: field.string() } },
});

function expectOk<TValue, TError>(
	result: Result<TValue, TError> | TValue,
): TValue {
	if (
		typeof result === 'object' &&
		result !== null &&
		'data' in result &&
		'error' in result
	) {
		const outcome = result as Result<TValue, TError>;
		if (outcome.error !== null) throw outcome.error;
		return outcome.data as TValue;
	}
	return result as TValue;
}

/**
 * A store that has lived: a rolling window of rows with prose, so creations,
 * edits and deletions INTERLEAVE. The interleaving is load-bearing for the
 * struct-count assertion: contiguous dead ranges merge into one GC struct,
 * while real churn leaves skeletons that cannot merge, which is the dead
 * weight ADR-0219 priced at about two items per deleted row.
 */
async function agedApplication(): Promise<DataOf<typeof database>> {
	const app = openMemory(database);
	const keep: string[] = [];
	for (let index = 0; index < 100; index += 1) {
		const row = expectOk(app.tables.notes.create({ title: `note ${index}` }));
		const opened = expectOk(await app.tables.notes.document.open(row.id));
		if (opened === undefined) throw new Error('the row has no document');
		const body = opened.get('body', 'text');
		body.applyDelta(body.change.insert('plain ') as never);
		body.applyDelta(
			body.change.retain(6).insert('bold', { bold: true }) as never,
		);
		opened[Symbol.dispose]();
		keep.push(row.id);
		// Touch an older survivor so clock ranges interleave.
		const older = keep[Math.max(0, keep.length - 3)] as string;
		expectOk(app.tables.notes.update(older, { title: `touched ${index}` }));
		if (keep.length > 10) {
			app.tables.notes.delete(keep.shift() as string);
		}
	}
	expectOk(app.kv.update({ theme: 'dark' }));
	return app;
}

/** One row's body root, opened for reading. */
async function bodyOf(app: DataOf<typeof database>, rowId: string) {
	const opened = expectOk(await app.tables.notes.document.open(rowId));
	if (opened === undefined) throw new Error('a row lost its document');
	return opened.get('body', 'text');
}

describe('rebuildDocument re-encodes live state into new identities (ADR-0231)', () => {
	test('same rows, same ids, same kv, same prose and marks', async () => {
		const source = await agedApplication();
		const reborn = expectOk(await rebuildDocument(source.store));

		const adopted = openMemory(database);
		expectOk(syncEngineOf(adopted.store).applyRemote(reborn));

		const before = source.tables.notes.list().rows;
		const after = adopted.tables.notes.list().rows;
		expect(after).toEqual(before);
		expect(after.length).toBe(10);
		expect(expectOk(adopted.kv.get())).toEqual(expectOk(source.kv.get()));

		for (const row of before) {
			const original = await bodyOf(source, row.id);
			const copied = await bodyOf(adopted, row.id);
			// Deep deltas rather than toJSON, because a shallow comparison passes
			// while silently dropping every formatting mark.
			expect(JSON.stringify(copied.toDeltaDeep())).toBe(
				JSON.stringify(original.toDeltaDeep()),
			);
			expect(JSON.stringify(copied.toDeltaDeep())).toContain('"bold":true');
		}
	});

	test('the tombstones are actually gone: the struct count falls', async () => {
		const source = await agedApplication();
		const reborn = expectOk(await rebuildDocument(source.store));
		const adopted = openMemory(database);
		expectOk(syncEngineOf(adopted.store).applyRemote(reborn));

		const agedItems = source.store.pressure().items;
		const rebornItems = adopted.store.pressure().items;
		expect(adopted.store.pressure().liveRows).toBe(
			source.store.pressure().liveRows,
		);
		// 90 deleted rows of interleaved churn against 10 live rows.
		expect(rebornItems).toBeLessThan(agedItems / 3);
	});

	test('a replica holding unresolved dependencies is refused', async () => {
		// A field edit whose row never arrived: Yjs buffers it silently (a bare
		// clock gap integrates fine in @y/y 14; a missing PARENT struct is what
		// pends), and a state built over that hole must not become the baseline.
		const writer = openMemory(database);
		const row = expectOk(writer.tables.notes.create({ title: 'base' }));
		const beforeEdit = writer.store.stateVector();
		expectOk(writer.tables.notes.update(row.id, { title: 'edited' }));
		const increment = writer.store.encodeStateSince(beforeEdit);

		const receiver = openMemory(database);
		expectOk(
			syncEngineOf(receiver.store).applyRemote(
				encodeEnvelope([{ document: APP_DOCUMENT, bytes: increment }]),
			),
		);
		expect(syncEngineOf(receiver.store).hasUnresolvedDependencies()).toBe(true);

		expect((await rebuildDocument(receiver.store)).error?.name).toBe(
			'UnresolvedDependencies',
		);
	});

	test('the brand separates reborn bytes from a plain re-encoding', () => {
		const app = openMemory(database);
		// @ts-expect-error encodeStateSince preserves identities and reclaims
		// nothing; only rebuildDocument() mints RebuiltState (ADR-0231).
		const wrong: RebuiltState = app.store.encodeStateSince();
		expect(wrong).toBeInstanceOf(Uint8Array);
	});
});

/** A scripted authority door: what the one verb answers, per POST. */
function scriptedTransport(script: { replace: (url: URL) => Response }) {
	const replaces: URL[] = [];
	const transport: StoreTransport = {
		baseURL: 'https://api.example.com',
		databaseId: database.id,
		fetch: async (input, init) => {
			if (init?.method !== 'POST') throw new Error('unexpected non-POST');
			const url = new URL(input);
			replaces.push(url);
			return script.replace(url);
		},
	};
	return { transport, replaces };
}

/** A synced store: stamped into a document, with a cursor. The lease's facts. */
function syncedApplication(cursor: number, document = 'the-current-document') {
	const app = openMemory(database);
	// Stamped first, in the order every real replica follows: the stamp
	// refuses a store that grew before it.
	expectOk(syncEngineOf(app.store).adoptDocumentIdentity(document));
	expectOk(app.tables.notes.create({ title: 'kept across compaction' }));
	if (cursor > 0) syncEngineOf(app.store).advance(cursor);
	return app;
}

describe('rebuildDatabase holds the lease honestly', () => {
	test('a synced store publishes in one post: fromDocument is its stamp, atHead its cursor', async () => {
		const app = syncedApplication(7);
		const { transport, replaces } = scriptedTransport({
			replace: () => Response.json({ document: 'the-next-document' }),
		});

		const published = await rebuildDatabase({ store: app.store, transport });

		expect(expectOk(published)).toEqual({ document: 'the-next-document' });
		expect(replaces).toHaveLength(1);
		const url = replaces[0] as URL;
		expect(url.searchParams.get('fromDocument')).toBe('the-current-document');
		expect(url.searchParams.get('atHead')).toBe('7');
		expect(url.searchParams.get('databaseId')).toBe(database.id);
	});

	test('an unstamped store is refused before anything is posted', async () => {
		// A store that never synced has no authority document its state
		// provably covers: nothing for the lease to name, nothing to rebuild
		// against.
		const app = openMemory(database);
		expectOk(app.tables.notes.create({ title: 'offline only' }));
		const { transport, replaces } = scriptedTransport({
			replace: () => Response.json({ document: 'never-reached' }),
		});

		const refused = await rebuildDatabase({ store: app.store, transport });

		expect(refused.error?.name).toBe('NeverSynced');
		expect(replaces).toHaveLength(0);
	});

	test('a moved log refuses the rebuild: sync, then try again', async () => {
		const app = syncedApplication(7);
		const { transport } = scriptedTransport({
			replace: () =>
				Response.json({ refused: 'head', head: 9 }, { status: 409 }),
		});

		const refused = await rebuildDatabase({ store: app.store, transport });

		expect(refused.error?.name).toBe('StoreChanged');
		expect(
			refused.error?.name === 'StoreChanged' ? refused.error.head : -1,
		).toBe(9);
	});

	test('a contested document resolves into adoption, and a crash-replay can never publish twice', async () => {
		// The loser of a concurrent pair and the crash-replay of a rebuild
		// that already landed arrive the same way: naming a document that is
		// no longer current. One post, one refusal, no retry that could stomp
		// the winner with stale-built bytes; the replica's next dial runs the
		// ordinary adoption.
		const app = syncedApplication(7);
		const { transport, replaces } = scriptedTransport({
			replace: () =>
				Response.json(
					{ refused: 'document', document: 'the-winning-document' },
					{ status: 409 },
				),
		});

		const contested = await rebuildDatabase({ store: app.store, transport });

		expect(contested.error?.name).toBe('Contested');
		expect(
			contested.error?.name === 'Contested' ? contested.error.document : '',
		).toBe('the-winning-document');
		expect(replaces).toHaveLength(1);
	});
});
