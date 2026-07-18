/**
 * Current-State Transport Classification Tests
 *
 * Verifies the narrow boundary between retryable authority interruption and
 * fatal replica/storage failures.
 *
 * Key behaviors:
 * - explicitly typed interruption becomes pending without changing its reason
 * - ordinary errors remain fatal
 * - fixed settlement cuts pass through unchanged
 */
import { expect, test } from 'bun:test';
import {
	CurrentStateTransportInterruption,
	classifyCurrentStateTransport,
} from './current-state-transport.js';

test('typed interruption becomes pending with its declared reason', async () => {
	const classified = classifyCurrentStateTransport({
		captureRecovery: () => null,
		isReady: () => true,
		startFreshLineage() {},
		captureAdmissionCut: () => 0,
		async synchronizeOnce() {
			throw new CurrentStateTransportInterruption(
				'authentication',
				'sign in again',
			);
		},
		async synchronizeThrough() {
			return { outcome: 'caught-up' };
		},
	});

	expect(await classified.synchronizeOnce()).toEqual({
		outcome: 'pending',
		reason: 'authentication',
	});
});

test('ordinary driver error remains fatal', async () => {
	const failure = new Error('malformed authority page');
	const classified = classifyCurrentStateTransport({
		captureRecovery: () => null,
		isReady: () => true,
		startFreshLineage() {},
		captureAdmissionCut: () => 0,
		async synchronizeOnce() {
			throw failure;
		},
		async synchronizeThrough() {
			return { outcome: 'caught-up' };
		},
	});

	await expect(classified.synchronizeOnce()).rejects.toBe(failure);
});

test('fixed settlement cut passes through unchanged', async () => {
	const cuts: number[] = [];
	const classified = classifyCurrentStateTransport({
		captureRecovery: () => null,
		isReady: () => true,
		startFreshLineage() {},
		captureAdmissionCut: () => 7,
		async synchronizeOnce() {
			return { outcome: 'caught-up' };
		},
		async synchronizeThrough(cut) {
			cuts.push(cut);
			return { outcome: 'caught-up' };
		},
	});

	expect(classified.captureAdmissionCut()).toBe(7);
	expect(await classified.synchronizeThrough(7)).toEqual({
		outcome: 'caught-up',
	});
	expect(cuts).toEqual([7]);
});
