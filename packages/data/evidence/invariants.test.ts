/**
 * The Yjs behaviour Epicenter's data model depends on, pinned.
 *
 * Every assertion here is a property of `@y/y@14.0.0-rc.24` rather than of
 * Epicenter's own code. They live in a test because they are load-bearing
 * design premises taken from a release candidate, and an rc can move them
 * quietly: one of them, that a type's behaviour comes from its name, was
 * asserted in a record as "verified" and turned out to be false.
 *
 * A failure here is not a bug in the store. It means an upgrade changed
 * something a decision was resting on, and the decision has to be re-read.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';

/** Exchange everything each side is missing, both directions. */
function sync(a: Y.Doc, b: Y.Doc): void {
	const fromA = Y.encodeStateAsUpdateV2(a, Y.encodeStateVector(b));
	const fromB = Y.encodeStateAsUpdateV2(b, Y.encodeStateVector(a));
	Y.applyUpdateV2(b, fromA);
	Y.applyUpdateV2(a, fromB);
}

function attrs(type: Y.Type): Record<string, unknown> {
	return type.getAttrs() as Record<string, unknown>;
}

describe('identity: a root is addressed by name, a nested type by struct', () => {
	test('two devices independently minting the SAME ROOT converge', () => {
		// Why KV lives at a reserved root. `Doc.get` is `setIfUndefined` on
		// `doc.share`, so the name IS the identity and independent minting is not
		// a conflict.
		const phone = new Y.Doc({ gc: true });
		const laptop = new Y.Doc({ gc: true });
		phone.get('!kv');
		laptop.get('!kv');
		phone.transact(() =>
			phone.get('!kv').setAttr('theme' as never, 'dark' as never),
		);
		laptop.transact(() =>
			laptop.get('!kv').setAttr('fontSize' as never, 22 as never),
		);
		sync(phone, laptop);

		expect(attrs(phone.get('!kv'))).toEqual({ theme: 'dark', fontSize: 22 });
		expect(attrs(laptop.get('!kv'))).toEqual({ theme: 'dark', fontSize: 22 });
		expect([...phone.share.keys()]).toEqual(['!kv']);
	});

	test('two devices independently minting the SAME NESTED TYPE lose one subtree', () => {
		// The failure this whole model is arranged to avoid. Map LWW keeps one
		// container and discards the other along with everything inside it, so a
		// chosen address written by two devices is not safe.
		const phone = new Y.Doc({ gc: true });
		const laptop = new Y.Doc({ gc: true });
		for (const [doc, key, value] of [
			[phone, 'theme', 'dark'],
			[laptop, 'fontSize', 22],
		] as const) {
			doc.transact(() => {
				const container = new Y.Type();
				doc.get('settings').setAttr('app' as never, container as never);
				container.setAttr(key as never, value as never);
			});
		}
		sync(phone, laptop);

		const read = (doc: Y.Doc) =>
			attrs(doc.get('settings').getAttr('app' as never) as unknown as Y.Type);
		// Converged, and one device's write is simply gone.
		expect(read(phone)).toEqual(read(laptop));
		expect(Object.keys(read(phone))).toHaveLength(1);
	});

	test('per-field merge is correct once the container exists', () => {
		// The safe case, and the reason minted ids are fine: create once, then
		// every field merges independently.
		const phone = new Y.Doc({ gc: true });
		const laptop = new Y.Doc({ gc: true });
		phone.transact(() => {
			const row = new Y.Type();
			phone.get('notes').setAttr('n1' as never, row as never);
			row.setAttr('title' as never, 'original' as never);
		});
		sync(phone, laptop);

		const rowOf = (doc: Y.Doc) =>
			doc.get('notes').getAttr('n1' as never) as unknown as Y.Type;
		phone.transact(() =>
			rowOf(phone).setAttr('title' as never, 'phone' as never),
		);
		laptop.transact(() =>
			rowOf(laptop).setAttr('date' as never, '2026-08-07' as never),
		);
		sync(phone, laptop);

		expect(attrs(rowOf(phone))).toEqual({ title: 'phone', date: '2026-08-07' });
		expect(attrs(rowOf(laptop))).toEqual(attrs(rowOf(phone)));
	});
});

describe('a state vector cannot express deletion', () => {
	test('two documents that disagree about a key hold IDENTICAL state vectors', () => {
		// The property that killed two authority designs, and the reason the
		// transport carries an integer log position instead. A delete marks an
		// existing struct rather than writing a new one, so no clock moves, so
		// "have I caught up" is a question a state vector cannot answer.
		const kept = new Y.Doc({ gc: true });
		kept.transact(() => {
			kept.get('notes').setAttr('x' as never, 1 as never);
			kept.get('notes').setAttr('y' as never, 2 as never);
		});
		const removed = new Y.Doc({ gc: true });
		Y.applyUpdateV2(removed, Y.encodeStateAsUpdateV2(kept));
		removed.transact(() => removed.get('notes').deleteAttr('y'));

		expect(Y.encodeStateVector(removed)).toEqual(Y.encodeStateVector(kept));
		expect(attrs(kept)).toEqual({ x: 1, y: 2 });
		expect(attrs(removed)).toEqual({ x: 1 });

		function attrs(doc: Y.Doc): Record<string, unknown> {
			return doc.get('notes').getAttrs() as Record<string, unknown>;
		}
	});

	test('a diff still carries the delete, so the bytes are not lost with it', () => {
		// The reassuring half, and it has to be stated too or the rule above reads
		// as "deletes do not replicate". They do: `encodeStateAsUpdateV2` writes
		// the whole delete set regardless of the state vector it is diffed
		// against. What is unavailable is the INFERENCE, not the data.
		const kept = new Y.Doc({ gc: true });
		kept.transact(() => {
			kept.get('notes').setAttr('x' as never, 1 as never);
			kept.get('notes').setAttr('y' as never, 2 as never);
		});
		const removed = new Y.Doc({ gc: true });
		Y.applyUpdateV2(removed, Y.encodeStateAsUpdateV2(kept));
		removed.transact(() => removed.get('notes').deleteAttr('y'));

		// The state vectors match, so a size-zero diff would be a defensible
		// implementation. It is not what happens.
		const diff = Y.encodeStateAsUpdateV2(removed, Y.encodeStateVector(kept));
		expect(diff.length).toBeGreaterThan(0);
		Y.applyUpdateV2(kept, diff);
		expect(kept.get('notes').getAttrs()).toEqual({ x: 1 });
	});
});

describe('delivery: what the transport must guarantee', () => {
	test('a nested-container update with missing dependencies is buffered SILENTLY', () => {
		// The most dangerous property in the library for this design, and it fires
		// on the exact shape a row has: create the container, then set a field in
		// it. No throw, no event, no public reader, empty document.
		// `hasUnresolvedDependencies()` in the store exists because of this.
		const origin = new Y.Doc({ gc: true });
		let row!: Y.Type;
		origin.transact(() => {
			row = new Y.Type();
			origin.get('notes').setAttr('n1' as never, row as never);
		});
		const first = Y.encodeStateAsUpdateV2(origin);
		const afterFirst = Y.encodeStateVector(origin);
		origin.transact(() => row.setAttr('title' as never, 'hello' as never));
		const second = Y.encodeStateAsUpdateV2(origin, afterFirst);

		const replica = new Y.Doc({ gc: true });
		let emitted = 0;
		replica.on('updateV2', () => {
			emitted += 1;
		});

		expect(() => Y.applyUpdateV2(replica, second)).not.toThrow();
		expect(emitted).toBe(0);
		expect(attrs(replica.get('notes'))).toEqual({});
		expect(pendingOf(replica)).toBe(true);

		// It resolves the moment the dependency arrives, and the resolving event
		// carries the buffered structs, which is why persisting RECEIVED bytes is
		// what makes the buffered update survive a restart.
		Y.applyUpdateV2(replica, first);
		expect(pendingOf(replica)).toBe(false);
		const recovered = replica
			.get('notes')
			.getAttr('n1' as never) as unknown as Y.Type;
		expect(attrs(recovered)).toEqual({ title: 'hello' });
	});

	test('an editing chain inside one type buffers the same way', () => {
		// The prose shape. Same silence, so an editor's updates are subject to it.
		const origin = new Y.Doc({ gc: true });
		const text = origin.get('editor', 'text');
		origin.transact(() =>
			text.applyDelta(text.change.insert('hello') as never),
		);
		const afterFirst = Y.encodeStateVector(origin);
		origin.transact(() =>
			text.applyDelta(text.change.retain(5).insert(' world') as never),
		);
		const second = Y.encodeStateAsUpdateV2(origin, afterFirst);

		const replica = new Y.Doc({ gc: true });
		Y.applyUpdateV2(replica, second);
		expect(pendingOf(replica)).toBe(true);
		expect(replica.get('editor', 'text').length).toBe(0);
	});

	test('a gap in independent map keys is honest, and a normal sync heals it', () => {
		// The reassuring half, and worth pinning so the rule is not overstated.
		// Two sets of DIFFERENT keys on one map root are independent, so the
		// second applies alone with nothing pending and a partial document. That
		// is safe, because the state vector still reports the gap and an ordinary
		// exchange resends what is missing. Silence is only dangerous where the
		// structs are causally chained, as in the two tests above.
		const origin = new Y.Doc({ gc: true });
		origin.transact(() =>
			origin.get('notes').setAttr('a' as never, 1 as never),
		);
		const afterFirst = Y.encodeStateVector(origin);
		origin.transact(() =>
			origin.get('notes').setAttr('b' as never, 2 as never),
		);

		const replica = new Y.Doc({ gc: true });
		Y.applyUpdateV2(replica, Y.encodeStateAsUpdateV2(origin, afterFirst));
		expect(attrs(replica.get('notes'))).toEqual({ b: 2 });
		expect(pendingOf(replica)).toBe(false);

		Y.applyUpdateV2(
			replica,
			Y.encodeStateAsUpdateV2(origin, Y.encodeStateVector(replica)),
		);
		expect(attrs(replica.get('notes'))).toEqual({ a: 1, b: 2 });
	});

	test('the internal field the store reads still exists', () => {
		// Pinned separately, because `hasUnresolvedDependencies()` reads an
		// internal that no public API replaces. If this moves, that reader is
		// silently always-false, which is worse than it throwing.
		const doc = new Y.Doc({ gc: true });
		const store = (doc as unknown as { store?: Record<string, unknown> }).store;
		expect(store).toBeDefined();
		expect('pendingStructs' in (store ?? {})).toBe(true);
		expect('pendingDs' in (store ?? {})).toBe(true);
	});

	test('updates are idempotent, so duplicate delivery is free', () => {
		const origin = new Y.Doc({ gc: true });
		origin.transact(() =>
			origin.get('notes').setAttr('a' as never, 1 as never),
		);
		const update = Y.encodeStateAsUpdateV2(origin);
		const replica = new Y.Doc({ gc: true });
		for (let i = 0; i < 3; i += 1) Y.applyUpdateV2(replica, update);
		expect(attrs(replica.get('notes'))).toEqual({ a: 1 });
	});

	test('updates converge under every delivery order, given all of them arrive', () => {
		// "Any order" is true. It is conditional on completeness, which is what
		// the pending-structs test above is really about: order is free, gaps are
		// not, and a gap is invisible.
		const origin = new Y.Doc({ gc: true });
		const updates: Uint8Array[] = [];
		let seen = Y.encodeStateVector(origin);
		for (const key of ['a', 'b', 'c', 'd']) {
			origin.transact(() =>
				origin.get('notes').setAttr(key as never, key as never),
			);
			updates.push(Y.encodeStateAsUpdateV2(origin, seen));
			seen = Y.encodeStateVector(origin);
		}
		const expected = attrs(origin.get('notes'));

		for (const order of permutations([0, 1, 2, 3])) {
			const replica = new Y.Doc({ gc: true });
			for (const index of order) {
				const update = updates[index];
				if (update !== undefined) Y.applyUpdateV2(replica, update);
			}
			expect(attrs(replica.get('notes'))).toEqual(expected);
			expect(pendingOf(replica)).toBe(false);
		}
	});
});

describe('reclamation: what deletion actually returns', () => {
	test('deleting a root attribute reclaims its value', () => {
		// Nesting is not required to get a value collected, which is what makes a
		// flat reserved root a viable home for KV.
		const doc = new Y.Doc({ gc: true });
		const kv = doc.get('!kv');
		doc.transact(() =>
			kv.setAttr('big' as never, 'x'.repeat(100_000) as never),
		);
		const before = Y.encodeStateAsUpdateV2(doc).length;
		doc.transact(() => kv.deleteAttr('big'));
		const after = Y.encodeStateAsUpdateV2(doc).length;

		expect(before).toBeGreaterThan(100_000);
		expect(after).toBeLessThan(200);
	});

	test('clearing a row and flagging it costs more than dropping the container', () => {
		// Both reclaim the content. The difference is what the tombstone carries,
		// and it is the open question in ADR-0212's choice of clear-and-flag: a
		// dropped container leaves one key, while clearing leaves one per field.
		const build = () => {
			const doc = new Y.Doc({ gc: true });
			const root = doc.get('notes');
			doc.transact(() => {
				for (let index = 0; index < 200; index += 1) {
					const row = new Y.Type();
					root.setAttr(
						`r${String(index).padStart(23, '0')}` as never,
						row as never,
					);
					row.setAttr('!presence' as never, 'present' as never);
					row.setAttr('title' as never, 'x'.repeat(200) as never);
				}
			});
			return { doc, root };
		};

		const dropped = build();
		dropped.doc.transact(() => {
			for (const key of [...dropped.root.attrKeys()]) {
				dropped.root.deleteAttr(key as string);
			}
		});

		const cleared = build();
		cleared.doc.transact(() => {
			for (const key of [...cleared.root.attrKeys()]) {
				const row = cleared.root.getAttr(key as never) as unknown as Y.Type;
				for (const field of [...row.attrKeys()]) {
					if (field !== '!presence') row.deleteAttr(field as string);
				}
				row.setAttr('!presence' as never, 'absent' as never);
			}
		});

		const droppedBytes = Y.encodeStateAsUpdateV2(dropped.doc).length / 200;
		const clearedBytes = Y.encodeStateAsUpdateV2(cleared.doc).length / 200;
		expect(droppedBytes).toBeLessThan(clearedBytes);
		// Both reclaim the 200-character titles rather than merely hiding them.
		expect(clearedBytes).toBeLessThan(200);
	});
});

describe('claims a record got wrong, kept so they stay wrong', () => {
	test("a type's name does NOT gate its behaviour", () => {
		// ADR-0215 asserted, as "verified", that `doc.get('editor')` silently
		// discards inserts while `doc.get('editor', 'text')` does not. False: the
		// original probe changed two variables and never called `applyDelta`. In
		// rc.24 the name is an inert label. If a later rc makes it load-bearing,
		// this test fails and the API that passes a type name has to be re-read.
		for (const name of [null, 'text', 'map', 'array']) {
			const doc = new Y.Doc({ gc: true });
			const type = name === null ? doc.get('editor') : doc.get('editor', name);
			doc.transact(() => type.applyDelta(type.change.insert('hello') as never));
			expect(type.length).toBe(5);
		}
	});

	test('a root minted by a remote update keeps no name', () => {
		// `Doc.get(key, name)` is `setIfUndefined`, so if a remote update mints a
		// root first, a later `get` with a name is ignored and the root stays
		// nameless. Harmless while names are inert; arrival-order-dependent type
		// identity the moment they are not.
		const origin = new Y.Doc({ gc: true });
		origin.transact(() =>
			origin.get('editor', 'text').setAttr('a' as never, 1 as never),
		);
		const replica = new Y.Doc({ gc: true });
		Y.applyUpdateV2(replica, Y.encodeStateAsUpdateV2(origin));

		const named = replica.get('editor', 'text') as unknown as {
			name?: unknown;
		};
		expect(named.name ?? null).toBeNull();
	});
});

function pendingOf(doc: Y.Doc): boolean {
	const store = (
		doc as unknown as {
			store?: { pendingStructs?: unknown; pendingDs?: unknown };
		}
	).store;
	return (
		(store?.pendingStructs ?? null) !== null ||
		(store?.pendingDs ?? null) !== null
	);
}

function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) return [[...items]];
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += 1) {
		const rest = [...items.slice(0, index), ...items.slice(index + 1)];
		for (const tail of permutations(rest)) {
			const head = items[index];
			if (head !== undefined) result.push([head, ...tail]);
		}
	}
	return result;
}

describe('a row document root is created lazily, and that is a defect', () => {
	test('two devices first-opening one note lose one of their prose', () => {
		// `document(id).get('editor', 'text')` CREATES on miss, so merely opening a
		// note is a write, and `new Y.Type()` is struct-addressed. Two devices that
		// open the same note before syncing each mint a type at the key `editor`,
		// map LWW keeps one, and the other's writing goes with it.
		//
		// This is precisely the failure ADR-0216 exists to prevent, and ADR-0215
		// guards the ROW's container against it ("allocated with the row, never on
		// first access") while saying nothing about the roots INSIDE that
		// container. It is reached by the most ordinary action a person takes:
		// opening the same note on a phone and a laptop.
		const phone = new Y.Doc({ gc: true });
		const laptop = new Y.Doc({ gc: true });
		phone.transact(() => {
			const row = new Y.Type();
			phone.get('notes').setAttr('n1' as never, row as never);
			row.setAttr('!doc' as never, new Y.Type() as never);
		});
		sync(phone, laptop);

		// Each opens the note, which mints `editor`, then types.
		for (const [doc, words] of [
			[phone, 'written on the phone'],
			[laptop, 'written on the laptop'],
		] as const) {
			doc.transact(() => {
				const container = (
					doc.get('notes').getAttr('n1' as never) as unknown as Y.Type
				).getAttr('!doc' as never) as unknown as Y.Type;
				const text = new Y.Type('text' as never);
				container.setAttr('editor' as never, text as never);
				text.applyDelta(text.change.insert(words) as never);
			});
		}
		sync(phone, laptop);

		const read = (doc: Y.Doc) =>
			JSON.stringify(
				(
					(
						doc.get('notes').getAttr('n1' as never) as unknown as Y.Type
					).getAttr('!doc' as never) as unknown as Y.Type
				).getAttr('editor' as never),
			);
		// Converged, and one person's writing is simply gone.
		expect(read(phone)).toBe(read(laptop));
		const survivors = ['phone', 'laptop'].filter((device) =>
			JSON.stringify(
				(
					(
						phone.get('notes').getAttr('n1' as never) as unknown as Y.Type
					).getAttr('!doc' as never) as unknown as Y.Type
				).getAttr('editor' as never) as unknown as Y.Type,
			).includes(device),
		);
		expect(survivors.length).toBeLessThan(2);
	});

	test('CONTROL: created ONCE, concurrent prose merges correctly', () => {
		// The same two devices, with the root allocated before they diverge. This
		// is what allocating a document's roots WITH the row would buy, and it is
		// the fix ADR-0215 already applied one level up.
		const phone = new Y.Doc({ gc: true });
		const laptop = new Y.Doc({ gc: true });
		phone.transact(() => {
			const row = new Y.Type();
			phone.get('notes').setAttr('n1' as never, row as never);
			const container = new Y.Type();
			row.setAttr('!doc' as never, container as never);
			container.setAttr(
				'editor' as never,
				new Y.Type('text' as never) as never,
			);
		});
		sync(phone, laptop);

		const editorOf = (doc: Y.Doc) =>
			(
				(doc.get('notes').getAttr('n1' as never) as unknown as Y.Type).getAttr(
					'!doc' as never,
				) as unknown as Y.Type
			).getAttr('editor' as never) as unknown as Y.Type;
		for (const [doc, words] of [
			[phone, 'AAA'],
			[laptop, 'BBB'],
		] as const) {
			doc.transact(() => {
				const text = editorOf(doc);
				text.applyDelta(text.change.insert(words) as never);
			});
		}
		sync(phone, laptop);

		const merged = JSON.stringify(editorOf(phone).toJSON());
		expect(merged).toContain('AAA');
		expect(merged).toContain('BBB');
	});
});
