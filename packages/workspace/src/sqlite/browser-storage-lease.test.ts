/**
 * Browser Storage Lease Tests
 *
 * Verifies fail-fast exclusive ownership over physical browser workspace keys
 * independently of the OPFS Worker runtime.
 *
 * Key behaviors:
 * - an unavailable physical key rejects instead of waiting
 * - explicit release permits the next owner
 * - release is idempotent
 */
import { expect, test } from 'bun:test';
import { acquireBrowserStorageLease } from './browser-storage-lease.js';

function setup() {
	const held = new Set<string>();
	const requests: string[] = [];
	const locks = {
		async request(
			name: string,
			_options: LockOptions,
			callback: (lock: Lock | null) => unknown,
		) {
			requests.push(name);
			if (held.has(name)) return callback(null);
			held.add(name);
			try {
				return await callback({ name, mode: 'exclusive' } as Lock);
			} finally {
				held.delete(name);
			}
		},
	} as unknown as LockManager;
	return { held, locks, requests };
}

test('unavailable storage rejects without waiting', async () => {
	const { locks } = setup();
	const first = await acquireBrowserStorageLease(locks, 'workspace');
	await expect(acquireBrowserStorageLease(locks, 'workspace')).rejects.toThrow(
		'Workspace storage already has an owner',
	);
	await first.release();
});

test('release permits the next storage owner', async () => {
	const { held, locks } = setup();
	const first = await acquireBrowserStorageLease(locks, 'workspace');
	expect(held.has('epicenter-sqlite-workspace')).toBe(true);
	await first.release();
	const second = await acquireBrowserStorageLease(locks, 'workspace');
	expect(held.has('epicenter-sqlite-workspace')).toBe(true);
	await second.release();
});

test('release is idempotent', async () => {
	const { held, locks, requests } = setup();
	const lease = await acquireBrowserStorageLease(locks, 'workspace');
	await lease.release();
	await lease.release();
	expect(held.size).toBe(0);
	expect(requests).toEqual(['epicenter-sqlite-workspace']);
});
