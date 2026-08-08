/**
 * Whether a row's document can be copied into a NEW identity space at all.
 *
 * This is the gate on every design that reclaims tombstones. Only a rebuild
 * reclaims them (`evidence/bench/tombstones.ts`: snapshot reclaims 0 items,
 * rebuild reclaims 142,000), and a rebuild means re-creating every live row as
 * new structs. A row owns a nested container whose contents the application
 * chose and Epicenter never interprets (ADR-0215), so rebuilding a row means
 * copying that container without knowing what is in it.
 *
 * **The library's own API for this is broken in `@y/y@14.0.0-rc.24`, and a
 * twelve-line recursion around it works.** Both halves are pinned here, because
 * either one alone is misleading.
 *
 * `clone()` is implemented as `_copy()` then `applyDelta(this.toDeltaDeep())`,
 * so every apparently different approach is the same code path and fails
 * identically: a nested type arrives inside the delta as a delta rather than as
 * a `YType`, and `typeMapSet` throws `Unexpected content type` on it. Upstream
 * intends `clone()` to be deep, so this is a defect rather than a boundary.
 *
 * The way around it is to stop asking `applyDelta` to do the nesting. Copy a
 * type's sequence content with its own delta, then walk its attributes and
 * recurse by hand, so a nested type is copied as a `YType` and set as a
 * `YType`, which is the one shape `typeMapSet` accepts.
 *
 * **What that costs conceptually:** the copy enumerates the names inside a row
 * document. It never interprets them, so ADR-0215's substance holds, Epicenter
 * still learns no formats and no meanings, but the phrase "learns none of the
 * names" is no longer literally true during a rebuild.
 */
import * as Y from '@y/y';
import { describe, expect, test } from 'bun:test';

/** A row document with the shapes an application actually puts in one. */
function sourceContainer(): { doc: Y.Doc; container: Y.Type } {
	const doc = new Y.Doc({ gc: true });
	const container = doc.get('!doc');
	doc.transact(() => {
		const text = new Y.Type('text' as never);
		container.setAttr('editor' as never, text as never);
		text.applyDelta(text.change.insert('plain ') as never);
		text.applyDelta(text.change.retain(6).insert('bold', { bold: true }) as never);

		const meta = new Y.Type();
		container.setAttr('meta' as never, meta as never);
		meta.setAttr('pinned' as never, true as never);
		// Two levels deep, which is ordinary rather than exotic: the application
		// names its own roots and nothing stops one holding another.
		const deep = new Y.Type();
		meta.setAttr('deep' as never, deep as never);
		deep.setAttr('level' as never, 2 as never);
	});
	return { doc, container };
}

function threw(run: () => void): string | undefined {
	try {
		run();
		return undefined;
	} catch (cause) {
		return cause instanceof Error ? cause.message : String(cause);
	}
}

describe('the library API for this is broken in rc.24', () => {
	test('clone() throws on a container holding a nested type', () => {
		const { container } = sourceContainer();
		const target = new Y.Doc({ gc: true });

		const failure = threw(() =>
			target.transact(() =>
				target.get('notes').setAttr('n1' as never, container.clone() as never),
			),
		);

		expect(failure).toBe('Unexpected content type');
	});

	test('replaying a deep delta throws, although producing one works', () => {
		// The asymmetry that makes this worth pinning. `toDeltaDeep` returns the
		// whole structure faithfully, formatting marks and all, so it is easy to
		// believe the copy is one call away. Applying it back is what fails.
		const { container } = sourceContainer();
		const deep = (
			container as unknown as { toDeltaDeep(): unknown }
		).toDeltaDeep();

		expect(JSON.stringify(deep)).toContain('"bold":true');
		expect(JSON.stringify(deep)).toContain('level');

		const target = new Y.Doc({ gc: true });
		const failure = threw(() =>
			target.transact(() => target.get('!doc').applyDelta(deep as never)),
		);

		expect(failure).toBe('Unexpected content type');
	});

	test('walking the attributes and replaying each child throws too', () => {
		// The hand-rolled version, which is what anyone tries next. It fails for
		// the same reason: the nested value still reaches `applyDelta` as a delta.
		// Recursing instead of replaying is what fixes it, below.
		const { container } = sourceContainer();
		const target = new Y.Doc({ gc: true });

		const failure = threw(() =>
			target.transact(() => {
				const fresh = target.get('!doc');
				for (const key of container.attrKeys()) {
					const child = container.getAttr(key as never) as unknown;
					if (!(child instanceof Y.Type)) {
						fresh.setAttr(key as never, child as never);
						continue;
					}
					const copy = new Y.Type(
						((child as unknown as { name?: string }).name ?? null) as never,
					);
					fresh.setAttr(key as never, copy as never);
					copy.applyDelta((child as Y.Type).delta as never);
				}
			}),
		);

		expect(failure).toBe('Unexpected content type');
	});

	test('CONTROL: a text-only container CAN be copied, so this is not "nothing works"', () => {
		// Without this the block above reads as a broken harness. A flat text
		// child copies cleanly; it is the nested type that has no path.
		const source = new Y.Doc({ gc: true });
		const container = source.get('!doc');
		source.transact(() => {
			const text = new Y.Type('text' as never);
			container.setAttr('editor' as never, text as never);
			text.applyDelta(text.change.insert('buy milk') as never);
		});

		const target = new Y.Doc({ gc: true });
		const failure = threw(() =>
			target.transact(() => {
				const fresh = new Y.Type('text' as never);
				target.get('!doc').setAttr('editor' as never, fresh as never);
				fresh.applyDelta(
					(container.getAttr('editor' as never) as unknown as Y.Type)
						.delta as never,
				);
			}),
		);

		expect(failure).toBeUndefined();
		expect(
			(target.get('!doc').getAttr('editor' as never) as unknown as Y.Type).length,
		).toBe('buy milk'.length);
	});
});

describe('the one BUILT-IN path that round-trips cannot be used', () => {
	test('an update copies everything exactly, and preserves identities', () => {
		// Which is the whole problem. This is the snapshot, and a snapshot
		// reclaims zero items, so it is not a rebuild no matter how it is framed.
		const { doc, container } = sourceContainer();
		const target = new Y.Doc({ gc: true });
		Y.applyUpdateV2(
			target,
			new Uint8Array(Y.encodeStateAsUpdateV2(doc)) as Uint8Array<ArrayBuffer>,
		);

		expect(JSON.stringify(target.get('!doc').toJSON())).toBe(
			JSON.stringify(container.toJSON()),
		);
		expect(itemCount(target)).toBe(itemCount(doc));
	});
});

function itemCount(doc: Y.Doc): number {
	const clients = (doc as unknown as {
		store?: { clients?: Map<number, { length: number }[]> };
	}).store?.clients;
	let total = 0;
	for (const structs of clients?.values() ?? []) total += structs.length;
	return total;
}

/**
 * Copy a type into NEW struct identities.
 *
 * The working alternative to `clone()`. Sequence content goes through the
 * type's own delta, which carries formatting; attributes are walked and
 * recursed, which is the step `applyDelta` cannot do because a nested type
 * reaches it as a delta rather than as a `YType`.
 *
 * `length` is the honest test for "does this hold a sequence". A map-like type
 * is zero, and applying its delta would carry the very attributes whose nested
 * values throw.
 */
function deepCopy(source: Y.Type): Y.Type {
	const name = (source as unknown as { name?: string | null }).name ?? null;
	const copy = new Y.Type(name as never);
	if (source.length > 0) copy.applyDelta(source.delta as never);
	for (const key of source.attrKeys()) {
		const value = source.getAttr(key as never) as unknown;
		copy.setAttr(
			key as never,
			(value instanceof Y.Type ? deepCopy(value) : value) as never,
		);
	}
	return copy;
}

describe('recursing by hand copies what clone() cannot', () => {
	test('the deep delta round-trips exactly, marks and nesting included', () => {
		const { container } = sourceContainer();
		const target = new Y.Doc({ gc: true });
		target.transact(() =>
			target.get('notes').setAttr('n1' as never, deepCopy(container) as never),
		);
		const copied = target.get('notes').getAttr('n1' as never) as unknown as Y.Type;

		expect(JSON.stringify(copied.toDeltaDeep())).toBe(
			JSON.stringify(container.toDeltaDeep()),
		);
		// Named separately, because a shallow `toJSON` comparison passes while
		// silently dropping every formatting mark, which is how a rebuild would
		// degrade prose in a way nobody notices for months.
		expect(JSON.stringify(copied.toDeltaDeep())).toContain('"bold":true');
	});

	test('CONTROL: the identities really are new, so something was reclaimed', () => {
		// The assertion that separates a copy from a snapshot. If the structs were
		// reused, a document holding the source would merge in for free and this
		// would not grow.
		const { doc: source, container } = sourceContainer();
		const target = new Y.Doc({ gc: true });
		target.transact(() =>
			target.get('notes').setAttr('n1' as never, deepCopy(container) as never),
		);
		const before = itemCount(target);
		Y.applyUpdateV2(
			target,
			new Uint8Array(
				Y.encodeStateAsUpdateV2(source, Y.encodeStateVector(target)),
			) as Uint8Array<ArrayBuffer>,
		);

		expect(itemCount(target)).toBeGreaterThan(before);
	});

	test('it reclaims an aged document, which is the whole point', () => {
		// 20,000 rows created and all but 500 deleted, which is the shape a few
		// years of ordinary churn produces.
		const aged = new Y.Doc({ gc: true });
		const root = aged.get('notes');
		const alive: string[] = [];
		for (let index = 0; index < 4_000; index += 1) {
			const key = `r${index}`;
			aged.transact(() => {
				const row = new Y.Type();
				root.setAttr(key as never, row as never);
				row.setAttr('title' as never, 'x'.repeat(60) as never);
				const container = new Y.Type();
				row.setAttr('!doc' as never, container as never);
				const text = new Y.Type('text' as never);
				container.setAttr('editor' as never, text as never);
				text.applyDelta(text.change.insert('body text here') as never);
			});
			alive.push(key);
			if (alive.length > 200) {
				const victim = alive.shift() as string;
				aged.transact(() => root.deleteAttr(victim));
			}
		}

		const rebuilt = new Y.Doc({ gc: true });
		rebuilt.transact(() => {
			const target = rebuilt.get('notes');
			for (const key of root.attrKeys()) {
				target.setAttr(
					key as never,
					deepCopy(root.getAttr(key as never) as unknown as Y.Type) as never,
				);
			}
		});

		expect(itemCount(rebuilt)).toBeLessThan(itemCount(aged) / 4);
		// CONTROL: it has to still show the same rows, or "reclaimed" only means
		// "threw away".
		expect(JSON.stringify(rebuilt.get('notes').toJSON())).toBe(
			JSON.stringify(root.toJSON()),
		);
	});
});
