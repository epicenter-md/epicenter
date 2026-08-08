/**
 * What opening Honeycrisp does when the store will not come up.
 *
 * The lifecycle is much smaller than it was. Opening a store is the only
 * asynchronous thing left, so there is no hydration to race, no abort to
 * unwind mid-flight, and no set of open documents to release: a note's prose
 * is a type in a document that was already replayed.
 */

import { expect, mock, test } from 'bun:test';

mock.module('$app/navigation', () => ({ goto: mock() }));
mock.module('$app/state', () => ({
	page: { url: new URL('https://honeycrisp.local/') },
}));

(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<TValue>(value: TValue) => value,
	{ raw: <TValue>(value: TValue) => value },
);
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
	<TValue>(value: TValue) => value,
	{ by: <TValue>(derive: () => TValue) => derive() },
);

const { openHoneycrispApplication } = await import('./application.js');

/** A store that binds however the test says, and counts its own disposal. */
function createStore(bind: () => unknown) {
	let disposals = 0;
	return {
		get disposals() {
			return disposals;
		},
		value: {
			bind,
			pressure: () => ({ data: undefined, error: null }),
			async [Symbol.asyncDispose]() {
				disposals += 1;
			},
		} as never,
	};
}

test('a lens the store refuses releases the store', async () => {
	const refusal = { name: 'Malformed', message: 'this lens is not a lens' };
	const store = createStore(() => ({ data: null, error: refusal }));

	await expect(
		openHoneycrispApplication({
			openStore: async () => store.value,
			reportBackgroundError() {},
		}),
	).rejects.toBe(refusal);

	expect(store.disposals).toBe(1);
});

test('an abort before the store opens never opens one', async () => {
	const controller = new AbortController();
	controller.abort();
	let opened = 0;

	await expect(
		openHoneycrispApplication(
			{
				openStore: async () => {
					opened += 1;
					return createStore(() => ({ data: {}, error: null })).value;
				},
				reportBackgroundError() {},
			},
			{ signal: controller.signal },
		),
	).rejects.toThrow();

	expect(opened).toBe(0);
});
