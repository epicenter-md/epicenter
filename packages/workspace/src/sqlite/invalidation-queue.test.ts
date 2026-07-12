import { expect, test } from 'bun:test';
import { createInvalidationRefreshQueue } from './invalidation-queue.js';

test('invalidation refresh retries, coalesces, and retains work added in flight', async () => {
	const attempts: unknown[] = [];
	const errors: unknown[] = [];
	let releaseFirst!: () => void;
	const firstAttempt = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let markRecovered!: () => void;
	const recovered = new Promise<void>((resolve) => {
		markRecovered = resolve;
	});
	let calls = 0;
	const queue = createInvalidationRefreshQueue({
		tables: new Set(['notes']),
		retryDelaysMs: [0],
		onError: (error) => errors.push(error),
		async refresh(invalidation) {
			attempts.push(invalidation);
			calls++;
			if (calls === 1) {
				await firstAttempt;
				throw new Error('SQLITE_BUSY');
			}
			markRecovered();
		},
	});

	queue.enqueue({ tables: { notes: ['one'] } });
	queue.enqueue({ tables: { notes: ['two'] } });
	releaseFirst();
	await recovered;
	await queue.dispose();

	expect(attempts).toEqual([
		{ tables: { notes: ['one'] } },
		{ tables: { notes: ['one', 'two'] } },
	]);
	expect(errors).toHaveLength(1);
});

test('invalidation refresh refuses unknown definition names', async () => {
	const errors: unknown[] = [];
	let refreshes = 0;
	const queue = createInvalidationRefreshQueue({
		tables: new Set(['notes']),
		onError: (error) => errors.push(error),
		async refresh() {
			refreshes++;
		},
	});

	queue.enqueue({ tables: { missing: ['one'] } });
	await queue.dispose();

	expect(refreshes).toBe(0);
	expect(errors).toHaveLength(1);
});
