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

test('an abort before the store opens rejects with the abort, not a storage failure', async () => {
	// What this protects is the ORDER: `signal?.throwIfAborted()` runs before
	// the store is opened, so an aborted boot never leaves one behind.
	//
	// It asserts the abort specifically rather than counting calls, because
	// there is no injected opener to count any more. Move the check below the
	// open and this fails on the error's identity: the real opener would run,
	// find no IndexedDB under bun, and reject with a storage failure instead.
	const controller = new AbortController();
	controller.abort();

	await expect(
		openHoneycrispApplication({ signal: controller.signal }),
	).rejects.toThrow(/abort/i);
});
