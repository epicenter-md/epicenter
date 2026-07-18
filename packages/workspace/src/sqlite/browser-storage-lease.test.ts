/**
 * Browser Storage Lease Tests
 *
 * Verifies newest-owner-wins exclusive ownership over physical browser
 * workspace keys independently of the OPFS Worker runtime.
 *
 * Key behaviors:
 * - a newer acquisition steals the key and notifies the previous owner
 * - explicit release permits the next owner without a steal
 * - release is idempotent and a released owner is never notified
 */
import { expect, test } from 'bun:test';
import { acquireBrowserStorageLease } from './browser-storage-lease.js';

type HeldLock = {
	settle(cause?: Error): void;
	completion: Promise<unknown>;
};

/** Web Locks double implementing `steal: true` semantics. */
function setup() {
	const held = new Map<string, HeldLock>();
	const requests: string[] = [];
	const locks = {
		request(
			name: string,
			_options: LockOptions,
			callback: (lock: Lock | null) => unknown,
		) {
			requests.push(name);
			const previous = held.get(name);
			const abort = new Error('The lock request is aborted');
			abort.name = 'AbortError';
			previous?.settle(abort);
			const settled = Promise.withResolvers<void>();
			const entry: HeldLock = {
				settle(cause) {
					if (cause) settled.reject(cause);
					else settled.resolve();
				},
				completion: Promise.resolve(),
			};
			entry.completion = (async () => {
				const run = callback({ name, mode: 'exclusive' } as Lock);
				await Promise.race([run, settled.promise]);
				if (held.get(name) === entry) held.delete(name);
				return run;
			})();
			held.set(name, entry);
			return entry.completion;
		},
	} as unknown as LockManager;
	return { held, locks, requests };
}

test('a newer acquisition steals the key and notifies the previous owner', async () => {
	const { locks } = setup();
	let stolen = 0;
	const first = await acquireBrowserStorageLease(locks, 'workspace', {
		onStolen: () => {
			stolen += 1;
		},
	});
	const second = await acquireBrowserStorageLease(locks, 'workspace');
	expect(stolen).toBe(1);
	// The stolen owner's release is a no-op that never throws.
	await first.release();
	await second.release();
	expect(stolen).toBe(1);
});

test('release permits the next storage owner without a steal', async () => {
	const { held, locks } = setup();
	let stolen = 0;
	const first = await acquireBrowserStorageLease(locks, 'workspace', {
		onStolen: () => {
			stolen += 1;
		},
	});
	expect(held.has('epicenter-sqlite-workspace')).toBe(true);
	await first.release();
	const second = await acquireBrowserStorageLease(locks, 'workspace');
	await second.release();
	expect(stolen).toBe(0);
	expect(held.size).toBe(0);
});

test('release is idempotent', async () => {
	const { held, locks, requests } = setup();
	const lease = await acquireBrowserStorageLease(locks, 'workspace');
	await lease.release();
	await lease.release();
	expect(held.size).toBe(0);
	expect(requests).toEqual(['epicenter-sqlite-workspace']);
});
