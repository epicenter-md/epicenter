/**
 * Contract tests for stopping contaminated engine runs and bounded cleanup.
 */
import { expect, test } from 'bun:test';

import { createEvidenceEngineLifecycle } from './engine-lifecycle.js';

test('engine lifecycle closes its context exactly once', async () => {
	let closeCount = 0;
	const lifecycle = createEvidenceEngineLifecycle(async () => {
		closeCount += 1;
	});

	expect(lifecycle.stoppedReason()).toBeUndefined();
	await Promise.all([lifecycle.close(), lifecycle.close()]);
	expect(closeCount).toBe(1);
});

test.each([
	{
		name: 'ordinary failure',
		unsupported: false,
		deadline: false,
		outcome: 'failed' as const,
	},
	{
		name: 'deadline reported as unsupported',
		unsupported: true,
		deadline: true,
		outcome: 'unsupported' as const,
	},
])('$name stops later cells and still closes the context', async (scenario) => {
	let closed = false;
	const lifecycle = createEvidenceEngineLifecycle(async () => {
		closed = true;
	});

	expect(
		lifecycle.recordCellFailure({
			reason: scenario.name,
			unsupported: scenario.unsupported,
			deadline: scenario.deadline,
		}),
	).toBe(scenario.outcome);
	expect(lifecycle.stoppedReason()).toBe(scenario.name);
	await lifecycle.close();
	expect(closed).toBe(true);
});

test('ordinary unsupported evidence does not contaminate later cells', () => {
	const lifecycle = createEvidenceEngineLifecycle(async () => undefined);
	expect(
		lifecycle.recordCellFailure({
			reason: 'capability unavailable',
			unsupported: true,
			deadline: false,
		}),
	).toBe('unsupported');
	expect(lifecycle.stoppedReason()).toBeUndefined();
});

test('engine lifecycle bounds context cleanup', async () => {
	let forceClosed = false;
	const lifecycle = createEvidenceEngineLifecycle(
		() => new Promise<void>(() => undefined),
		async () => {
			forceClosed = true;
		},
		10,
	);

	await expect(lifecycle.close()).rejects.toThrow(
		'Browser context cleanup exceeded 10ms',
	);
	expect(forceClosed).toBe(true);
});

test('engine lifecycle retains graceful and forced cleanup failures', async () => {
	const lifecycle = createEvidenceEngineLifecycle(
		async () => {
			throw new Error('graceful close failed');
		},
		async () => {
			throw new Error('forced close failed');
		},
	);

	await expect(lifecycle.close()).rejects.toThrow(
		'Browser context cleanup and forced cleanup both failed',
	);
});
