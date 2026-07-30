import { expect, test } from 'bun:test';

import {
	acquireBrowserStorageLease,
	type LockManagerPort,
} from './storage-lease.js';

test('an already-aborted acquisition never requests the lock', async () => {
	let callbackRan = false;
	const locks: LockManagerPort = {
		async request(_name, _options, callback) {
			callbackRan = true;
			await callback({});
		},
	};
	const controller = new AbortController();
	const cause = new Error('Caller disconnected');
	controller.abort(cause);

	await expect(
		acquireBrowserStorageLease(locks, { signal: controller.signal }),
	).rejects.toBe(cause);
	expect(callbackRan).toBe(false);
});

test('aborting after acquisition retains the lock until explicit release', async () => {
	const lockCompleted = Promise.withResolvers<void>();
	const locks: LockManagerPort = {
		async request(_name, _options, callback) {
			await callback({});
			lockCompleted.resolve();
		},
	};
	const controller = new AbortController();
	const lease = await acquireBrowserStorageLease(locks, {
		signal: controller.signal,
	});
	let completed = false;
	void lockCompleted.promise.then(() => {
		completed = true;
	});

	controller.abort(new Error('Caller disconnected'));
	await Promise.resolve();
	expect(completed).toBe(false);

	await lease.release();
	expect(completed).toBe(true);
});

test('a second owner is refused instead of waiting behind the active tab', async () => {
	const locks: LockManagerPort = {
		async request(_name, _options, callback) {
			await callback(null);
		},
	};

	await expect(acquireBrowserStorageLease(locks)).rejects.toThrow(
		'Browser Epicenter is already open in another tab for this origin',
	);
});
