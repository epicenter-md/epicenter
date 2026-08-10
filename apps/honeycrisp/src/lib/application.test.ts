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

/**
 * An opened application, counting its own disposal.
 *
 * A lens the store refuses no longer reaches here. `open` binds the lens that
 * named it (ADR-0229), so a refusal never produces an application at all, and
 * the store it half-opened is disposed by the opener. That case is proved where
 * it now lives, in `packages/data/src/store/store.test.ts`.
 */
function createApplication() {
	let disposals = 0;
	return {
		get disposals() {
			return disposals;
		},
		value: {
			pressure: () => ({ data: undefined, error: null }),
			async [Symbol.asyncDispose]() {
				disposals += 1;
			},
		} as never,
	};
}

test('an abort before the application opens never opens one', async () => {
	const controller = new AbortController();
	controller.abort();
	let opened = 0;

	await expect(
		openHoneycrispApplication(
			{
				open: async () => {
					opened += 1;
					return createApplication().value;
				},
				reportBackgroundError() {},
			},
			{ signal: controller.signal },
		),
	).rejects.toThrow();

	expect(opened).toBe(0);
});
