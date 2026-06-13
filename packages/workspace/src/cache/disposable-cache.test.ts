import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { createDisposableCache } from './disposable-cache.js';

/**
 * Helper: a minimal Disposable wrapping a Y.Doc. Y.Doc is the most common
 * real-world value, but the cache itself is generic; these tests exercise
 * the cache through Y.Doc only because Y.Doc.isDestroyed gives an easy
 * "did dispose actually run?" assertion.
 */
function makeYDocCache({ gcTime }: { gcTime?: number } = {}) {
	return createDisposableCache(
		(id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			return {
				ydoc,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		},
		{ gcTime },
	);
}

// ════════════════════════════════════════════════════════════════════════════
// open / cache identity
// ════════════════════════════════════════════════════════════════════════════

describe('open / cache identity', () => {
	test('same id shares the underlying value across handles; different ids get separate values', () => {
		const cache = makeYDocCache();
		const [a1, a2, a3] = [cache.open('a'), cache.open('a'), cache.open('a')];
		const b = cache.open('b');

		expect(a1).not.toBe(a2);
		expect(a1.ydoc).toBe(a2.ydoc);
		expect(a2.ydoc).toBe(a3.ydoc);
		expect(b.ydoc).not.toBe(a1.ydoc);
		expect(b.ydoc.guid).toBe('b');

		a1[Symbol.dispose]();
		a2[Symbol.dispose]();
		a3[Symbol.dispose]();
		b[Symbol.dispose]();
	});

	test('writes to one handle do not leak to other handles for the same id', () => {
		const cache = createDisposableCache((_id: string) => ({
			counter: 0,
			[Symbol.dispose]() {},
		}));
		const a = cache.open('a') as unknown as { counter: number } & Disposable;
		const b = cache.open('a') as unknown as { counter: number } & Disposable;
		a.counter = 99;
		expect(b.counter).toBe(0);
		a[Symbol.dispose]();
		b[Symbol.dispose]();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// throwing build closure
// ════════════════════════════════════════════════════════════════════════════

describe('throwing build closure', () => {
	test('error propagates and the cache does not store the id', () => {
		let calls = 0;
		const cache = createDisposableCache((id: string) => {
			calls++;
			if (calls === 1) throw new Error('boom');
			const ydoc = new Y.Doc({ guid: id });
			return {
				ydoc,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		});

		expect(() => cache.open('foo')).toThrow('boom');
		expect(cache.has('foo')).toBe(false);
		// The second attempt must run the closure again; no poisoned entry.
		const handle = cache.open('foo');
		expect(calls).toBe(2);
		expect(handle.ydoc.guid).toBe('foo');
		handle[Symbol.dispose]();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// arbitrary fields flow through the handle
// ════════════════════════════════════════════════════════════════════════════

describe('arbitrary fields flow through the handle', () => {
	test('builder-attached fields are readable on every handle', () => {
		const cache = createDisposableCache((id: string) => {
			const ydoc = new Y.Doc({ guid: id });
			return {
				ydoc,
				body: { kind: 'rich-text' as const },
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		});
		const a = cache.open('a');
		const b = cache.open('a');
		expect(a.body.kind).toBe('rich-text');
		expect(b.body.kind).toBe('rich-text');
		expect(a.body).toBe(b.body); // same reference under the hood
		a[Symbol.dispose]();
		b[Symbol.dispose]();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// has()
// ════════════════════════════════════════════════════════════════════════════

describe('has()', () => {
	test('returns false before open, true while held, false after teardown', () => {
		const cache = makeYDocCache({ gcTime: 0 });
		expect(cache.has('a')).toBe(false);
		const h = cache.open('a');
		expect(cache.has('a')).toBe(true);
		h[Symbol.dispose]();
		expect(cache.has('a')).toBe(false);
	});

	test('returns true during the gcTime grace window', async () => {
		const cache = makeYDocCache({ gcTime: 50 });
		const h = cache.open('a');
		h[Symbol.dispose]();
		expect(cache.has('a')).toBe(true);
		await new Promise((r) => setTimeout(r, 80));
		expect(cache.has('a')).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// cache-level dispose (replaces close() / closeAll())
// ════════════════════════════════════════════════════════════════════════════

describe('cache[Symbol.dispose]', () => {
	test('disposes every entry; subsequent open() constructs fresh values', () => {
		const cache = makeYDocCache();
		const a1 = cache.open('a');
		const b1 = cache.open('b');
		const ydocA = a1.ydoc;
		const ydocB = b1.ydoc;
		cache[Symbol.dispose]();
		expect(ydocA.isDestroyed).toBe(true);
		expect(ydocB.isDestroyed).toBe(true);
		const a2 = cache.open('a');
		const b2 = cache.open('b');
		expect(a2.ydoc).not.toBe(ydocA);
		expect(b2.ydoc).not.toBe(ydocB);
		a2[Symbol.dispose]();
		b2[Symbol.dispose]();
	});

	test('a throwing value [Symbol.dispose] does not propagate; cache still evicts', () => {
		let calls = 0;
		const cache = createDisposableCache((id: string) => {
			calls++;
			const ydoc = new Y.Doc({ guid: id });
			return {
				ydoc,
				[Symbol.dispose]() {
					ydoc.destroy();
					throw new Error('dispose boom');
				},
			};
		});

		const prevError = console.error;
		console.error = () => {};
		try {
			const h = cache.open('a');
			h[Symbol.dispose]();
			expect(() => cache[Symbol.dispose]()).not.toThrow();
			const h2 = cache.open('a');
			expect(calls).toBe(2);
			h2[Symbol.dispose]();
		} finally {
			console.error = prevError;
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
// open / dispose: refcount, grace-period disposal, disposable protocol
// ════════════════════════════════════════════════════════════════════════════

describe('open / dispose', () => {
	test('refcount: two opens require two disposes before grace timer starts', async () => {
		const cache = makeYDocCache({ gcTime: 15 });
		const h1 = cache.open('a');
		const h2 = cache.open('a');
		h1[Symbol.dispose]();
		await new Promise((r) => setTimeout(r, 30));
		expect(h1.ydoc.isDestroyed).toBe(false);
		h2[Symbol.dispose]();
		await new Promise((r) => setTimeout(r, 30));
		expect(h1.ydoc.isDestroyed).toBe(true);
	});

	test('per-handle dispose is idempotent', async () => {
		const cache = makeYDocCache({ gcTime: 10 });
		const h1 = cache.open('a');
		const h2 = cache.open('a');
		h1[Symbol.dispose]();
		h1[Symbol.dispose]();
		await new Promise((r) => setTimeout(r, 30));
		expect(h1.ydoc.isDestroyed).toBe(false);
		h2[Symbol.dispose]();
		await new Promise((r) => setTimeout(r, 30));
		expect(h1.ydoc.isDestroyed).toBe(true);
	});

	test('open() during grace cancels the pending disposal', async () => {
		const cache = makeYDocCache({ gcTime: 20 });
		const h1 = cache.open('a');
		h1[Symbol.dispose]();
		await new Promise((r) => setTimeout(r, 5));
		const h2 = cache.open('a');
		expect(h2.ydoc).toBe(h1.ydoc);

		await new Promise((r) => setTimeout(r, 35));
		expect(h2.ydoc.isDestroyed).toBe(false);

		h2[Symbol.dispose]();
		await new Promise((r) => setTimeout(r, 35));
		expect(h2.ydoc.isDestroyed).toBe(true);
	});

	test('handle dispose captured before cache dispose is a safe no-op afterward', async () => {
		const cache = makeYDocCache({ gcTime: 100 });
		const h = cache.open('a');
		cache[Symbol.dispose]();
		h[Symbol.dispose]();
		await new Promise((r) => setTimeout(r, 20));
		expect(h.ydoc.isDestroyed).toBe(true);
	});

	test('gcTime: 0 tears down synchronously on last dispose', () => {
		const cache = makeYDocCache({ gcTime: 0 });
		const h1 = cache.open('a');
		const h2 = cache.open('a');
		h1[Symbol.dispose]();
		expect(h1.ydoc.isDestroyed).toBe(false);
		h2[Symbol.dispose]();
		expect(h1.ydoc.isDestroyed).toBe(true);
	});

	test('gcTime: Infinity keeps entry live indefinitely; cache dispose forces teardown', async () => {
		const cache = makeYDocCache({ gcTime: Number.POSITIVE_INFINITY });
		const h = cache.open('a');
		const ydoc = h.ydoc;
		h[Symbol.dispose]();
		await new Promise((r) => setTimeout(r, 50));
		expect(ydoc.isDestroyed).toBe(false);

		const h2 = cache.open('a');
		expect(h2.ydoc).toBe(ydoc);
		h2[Symbol.dispose]();

		cache[Symbol.dispose]();
		expect(ydoc.isDestroyed).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// re-entrancy
// ════════════════════════════════════════════════════════════════════════════

describe('re-entrancy', () => {
	test("value's [Symbol.dispose] can re-enter via cache.open(sameId) and gets a fresh entry", () => {
		// During teardown, the entry is removed from the cache's internal map
		// BEFORE the value's [Symbol.dispose]() runs. So a re-entrant open of
		// the same id during teardown must construct a brand new entry, not
		// resurrect the about-to-be-destroyed one.
		// biome-ignore lint/suspicious/noExplicitAny: cache referenced inside its own builder
		let cache: any;
		let buildCount = 0;
		// biome-ignore lint/suspicious/noExplicitAny: handle type is parameterized via the cache itself
		let reopenedHandle: any;
		cache = createDisposableCache(
			(id: string) => {
				buildCount++;
				const buildIndex = buildCount;
				return {
					id,
					buildIndex,
					[Symbol.dispose]() {
						// Only re-open once, from the first instance's teardown.
						if (buildIndex === 1 && !reopenedHandle) {
							reopenedHandle = cache.open(id);
						}
					},
				};
			},
			{ gcTime: 0 },
		);

		const h = cache.open('a');
		h[Symbol.dispose]();

		// The dispose triggered a re-open. We should now have a fresh entry,
		// not a stale reference to the just-destroyed one.
		expect(buildCount).toBe(2);
		expect(reopenedHandle.buildIndex).toBe(2);
		expect(cache.has('a')).toBe(true);
		reopenedHandle[Symbol.dispose]();
		expect(cache.has('a')).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// whenReleased
// ════════════════════════════════════════════════════════════════════════════

describe('whenReleased', () => {
	test('resolves immediately when nothing holds the id', async () => {
		const cache = makeYDocCache({ gcTime: 0 });
		await expect(cache.whenReleased('absent')).resolves.toBeUndefined();
	});

	test('stays pending while held, resolves once the last handle disposes', async () => {
		const cache = makeYDocCache({ gcTime: 0 });
		const handle = cache.open('a');
		const released = cache.whenReleased('a');
		let settled = false;
		void released.then(() => {
			settled = true;
		});

		await Promise.resolve();
		expect(settled).toBe(false); // still held
		expect(handle.ydoc.isDestroyed).toBe(false);

		handle[Symbol.dispose]();
		await released;
		expect(settled).toBe(true);
		// The underlying dispose ran before the waiter resumed: the whole point of
		// the "dispose before clear" ordering callers depend on.
		expect(handle.ydoc.isDestroyed).toBe(true);
	});

	test('observing a release never triggers one', async () => {
		const cache = makeYDocCache({ gcTime: 0 });
		const handle = cache.open('a');
		void cache.whenReleased('a');
		await Promise.resolve();
		expect(cache.has('a')).toBe(true);
		expect(handle.ydoc.isDestroyed).toBe(false);
		handle[Symbol.dispose]();
	});
});
