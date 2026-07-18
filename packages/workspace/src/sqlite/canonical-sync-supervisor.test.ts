/**
 * Canonical Sync Supervisor Tests
 *
 * Verifies the workspace-owned scheduling lifecycle independently from the
 * row protocol and SQLite replica. A deterministic scheduler proves startup,
 * coalescing, fixed settlement cuts, retry, safety parking, and disposal.
 *
 * Key behaviors:
 * - Only one driver operation runs at a time and wakeups coalesce
 * - Settlement retains its invocation-time admission cut
 * - Pending work retries while recovery and disposal park networking
 */

import { expect, test } from 'bun:test';
import {
	type CanonicalSyncDriverResult,
	type CanonicalSyncSupervisorDriver,
	createCanonicalSyncSupervisor,
	type WorkspaceSyncStatus,
} from './canonical-sync-supervisor.js';

type Timer = ReturnType<typeof setTimeout>;

function deferred<TValue>() {
	let resolve!: (value: TValue) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<TValue>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

function createTestScheduler() {
	let nextTimerId = 1;
	const tasks: (() => void)[] = [];
	const timers = new Map<Timer, { task: () => void; delayMs: number }>();

	return {
		scheduler: {
			queueTask(task: () => void): void {
				tasks.push(task);
			},
			setTimer(task: () => void, delayMs: number): Timer {
				const timer = nextTimerId as unknown as Timer;
				nextTimerId += 1;
				timers.set(timer, { task, delayMs });
				return timer;
			},
			clearTimer(timer: Timer): void {
				timers.delete(timer);
			},
		},
		flushTasks(): void {
			for (const task of tasks.splice(0)) task();
		},
		runTimer(delayMs: number): void {
			const entry = [...timers].find(([, timer]) => timer.delayMs === delayMs);
			if (!entry) throw new Error(`No timer scheduled for ${delayMs}ms`);
			const [id, timer] = entry;
			timers.delete(id);
			timer.task();
		},
		get timerDelays(): number[] {
			return [...timers.values()].map(({ delayMs }) => delayMs);
		},
	};
}

function setup({
	synchronizeOnce,
	synchronizeThrough,
	isReady = () => true,
	startFreshLineage = () => undefined,
}: {
	synchronizeOnce?: () => Promise<CanonicalSyncDriverResult>;
	synchronizeThrough?: (cut: number) => Promise<CanonicalSyncDriverResult>;
	isReady?: () => boolean;
	startFreshLineage?: () => void;
} = {}) {
	let admissionCut = 0;
	const onceCalls: true[] = [];
	const throughCalls: number[] = [];
	const capturedCuts: number[] = [];
	const fatalCauses: unknown[] = [];
	const statusObserverCauses: unknown[] = [];
	const testScheduler = createTestScheduler();
	const driver: CanonicalSyncSupervisorDriver = {
		captureRecovery: () => null,
		isReady,
		startFreshLineage,
		captureAdmissionCut() {
			capturedCuts.push(admissionCut);
			return admissionCut;
		},
		async synchronizeOnce() {
			onceCalls.push(true);
			return (await synchronizeOnce?.()) ?? { outcome: 'caught-up' as const };
		},
		async synchronizeThrough(cut) {
			throughCalls.push(cut);
			return (
				(await synchronizeThrough?.(cut)) ?? { outcome: 'caught-up' as const }
			);
		},
	};
	const supervisor = createCanonicalSyncSupervisor({
		driver,
		onFatal: (cause) => fatalCauses.push(cause),
		onStatusObserverError: (cause) => statusObserverCauses.push(cause),
		pollIntervalMs: 10_000,
		retryBaseDelayMs: 100,
		retryMaxDelayMs: 400,
		random: () => 1,
		scheduler: testScheduler.scheduler,
	});

	return {
		supervisor,
		onceCalls,
		throughCalls,
		capturedCuts,
		fatalCauses,
		statusObserverCauses,
		flushTasks: testScheduler.flushTasks,
		runTimer: testScheduler.runTimer,
		getTimerDelays(): number[] {
			return testScheduler.timerDelays;
		},
		setAdmissionCut(cut: number): void {
			admissionCut = cut;
		},
	};
}

async function flushAsyncWork(flushTasks: () => void): Promise<void> {
	for (let count = 0; count < 5; count += 1) {
		flushTasks();
		await Promise.resolve();
	}
}

test('startup synchronizes once and reports caught up', async () => {
	const { supervisor, onceCalls, flushTasks } = setup();
	const statuses: WorkspaceSyncStatus[] = [];
	supervisor.onStatusChange((status) => statuses.push(status));

	await flushAsyncWork(flushTasks);

	expect(onceCalls).toHaveLength(1);
	expect(supervisor.status).toEqual({ phase: 'caught-up' });
	expect(statuses).toEqual([{ phase: 'caught-up' }]);
});

test('wakeups during one active operation coalesce into one follow-up', async () => {
	const first = deferred<CanonicalSyncDriverResult>();
	let invocation = 0;
	const { supervisor, onceCalls, flushTasks } = setup({
		synchronizeOnce() {
			invocation += 1;
			return invocation === 1
				? first.promise
				: Promise.resolve({ outcome: 'caught-up' });
		},
	});
	flushTasks();
	await Promise.resolve();

	supervisor.wake();
	supervisor.wake();
	supervisor.wake();
	expect(onceCalls).toHaveLength(1);

	first.resolve({ outcome: 'caught-up' });
	await flushAsyncWork(flushTasks);

	expect(onceCalls).toHaveLength(2);
});

test('active work reports syncing before returning to caught up', async () => {
	const active = deferred<CanonicalSyncDriverResult>();
	let invocation = 0;
	const { supervisor, flushTasks } = setup({
		synchronizeOnce() {
			invocation += 1;
			return invocation === 1
				? Promise.resolve({ outcome: 'caught-up' })
				: active.promise;
		},
	});
	await flushAsyncWork(flushTasks);
	const statuses: WorkspaceSyncStatus[] = [];
	supervisor.onStatusChange((status) => statuses.push(status));

	supervisor.wake();
	flushTasks();
	await Promise.resolve();
	expect(supervisor.status).toEqual({ phase: 'syncing' });

	active.resolve({ outcome: 'caught-up' });
	await flushAsyncWork(flushTasks);
	expect(statuses).toEqual([{ phase: 'syncing' }, { phase: 'caught-up' }]);
});

test('throwing status observer does not stop synchronization', async () => {
	const observerFailure = new Error('Broken status view');
	const { supervisor, statusObserverCauses, fatalCauses, flushTasks } = setup();
	supervisor.onStatusChange(() => {
		throw observerFailure;
	});
	const observed: WorkspaceSyncStatus[] = [];
	supervisor.onStatusChange((status) => observed.push(status));

	await flushAsyncWork(flushTasks);

	expect(supervisor.status).toEqual({ phase: 'caught-up' });
	expect(observed).toEqual([{ phase: 'caught-up' }]);
	expect(statusObserverCauses).toEqual([observerFailure]);
	expect(fatalCauses).toEqual([]);
});

test('settle captures one cut and finishes older cuts before newer work', async () => {
	const firstCut = deferred<CanonicalSyncDriverResult>();
	let firstCutInvocations = 0;
	const {
		supervisor,
		setAdmissionCut,
		throughCalls,
		capturedCuts,
		flushTasks,
	} = setup({
		synchronizeThrough(cut) {
			if (cut === 5) {
				firstCutInvocations += 1;
				return firstCutInvocations === 1
					? firstCut.promise
					: Promise.resolve({ outcome: 'caught-up' });
			}
			return Promise.resolve({ outcome: 'caught-up' });
		},
	});
	await flushAsyncWork(flushTasks);

	setAdmissionCut(5);
	const older = supervisor.settle();
	flushTasks();
	await Promise.resolve();
	setAdmissionCut(9);
	const newer = supervisor.settle();
	supervisor.wake();

	expect(capturedCuts).toEqual([5, 9]);
	expect(throughCalls).toEqual([5]);

	firstCut.resolve({ outcome: 'progress' });
	await flushAsyncWork(flushTasks);

	await expect(older).resolves.toEqual({ outcome: 'caught-up' });
	await expect(newer).resolves.toEqual({ outcome: 'caught-up' });
	expect(throughCalls).toEqual([5, 5, 9]);
});

test('settleThrough preserves a cut captured before later admission', async () => {
	const {
		supervisor,
		setAdmissionCut,
		throughCalls,
		capturedCuts,
		flushTasks,
	} = setup();
	await flushAsyncWork(flushTasks);

	setAdmissionCut(4);
	const cut = supervisor.captureAdmissionCut();
	setAdmissionCut(8);
	const settlement = supervisor.settleThrough(cut);
	await flushAsyncWork(flushTasks);

	await expect(settlement).resolves.toEqual({ outcome: 'caught-up' });
	expect(capturedCuts).toEqual([4]);
	expect(throughCalls).toEqual([4]);
});

test('pending settlement returns while background retry continues', async () => {
	let invocation = 0;
	const { supervisor, setAdmissionCut, flushTasks, runTimer, getTimerDelays } =
		setup({
			synchronizeThrough() {
				invocation += 1;
				return Promise.resolve(
					invocation === 1
						? { outcome: 'pending', reason: 'offline' }
						: { outcome: 'caught-up' },
				);
			},
		});
	await flushAsyncWork(flushTasks);
	setAdmissionCut(3);

	const settlement = supervisor.settle();
	await flushAsyncWork(flushTasks);

	await expect(settlement).resolves.toEqual({
		outcome: 'pending',
		reason: 'offline',
	});
	expect(supervisor.status).toEqual({ phase: 'pending', reason: 'offline' });
	expect(getTimerDelays()).toContain(100);

	runTimer(100);
	await flushAsyncWork(flushTasks);
	expect(supervisor.status).toEqual({ phase: 'caught-up' });
});

test('online notification skips the remaining retry delay', async () => {
	let isOffline = true;
	const { supervisor, flushTasks, getTimerDelays } = setup({
		synchronizeOnce() {
			return Promise.resolve(
				isOffline
					? { outcome: 'pending', reason: 'offline' }
					: { outcome: 'caught-up' },
			);
		},
	});
	await flushAsyncWork(flushTasks);
	expect(getTimerDelays()).toContain(100);

	isOffline = false;
	supervisor.notifyOnline();
	await flushAsyncWork(flushTasks);

	expect(getTimerDelays()).not.toContain(100);
	expect(supervisor.status).toEqual({ phase: 'caught-up' });
});

test('repeated interruption backs off exponentially up to the configured bound', async () => {
	const { flushTasks, runTimer, getTimerDelays } = setup({
		synchronizeOnce() {
			return Promise.resolve({ outcome: 'pending', reason: 'retrying' });
		},
	});
	await flushAsyncWork(flushTasks);
	expect(getTimerDelays()).toContain(100);

	runTimer(100);
	await flushAsyncWork(flushTasks);
	expect(getTimerDelays()).toContain(200);

	runTimer(200);
	await flushAsyncWork(flushTasks);
	expect(getTimerDelays()).toContain(400);

	runTimer(400);
	await flushAsyncWork(flushTasks);
	expect(getTimerDelays().filter((delayMs) => delayMs === 400)).toHaveLength(1);
});

test('recovery requirement parks all future networking', async () => {
	const { supervisor, onceCalls, capturedCuts, flushTasks, getTimerDelays } =
		setup({
			synchronizeOnce() {
				return Promise.resolve({
					outcome: 'recovery-required',
					reason: 'lineage-mismatch',
				});
			},
		});
	await flushAsyncWork(flushTasks);

	expect(supervisor.status).toEqual({
		phase: 'recovery-required',
		reason: 'lineage-mismatch',
	});
	expect(getTimerDelays()).toEqual([]);
	supervisor.wake();
	supervisor.notifyOnline();
	await expect(supervisor.settle()).resolves.toEqual({
		outcome: 'recovery-required',
		reason: 'lineage-mismatch',
	});
	await flushAsyncWork(flushTasks);

	expect(onceCalls).toHaveLength(1);
	expect(capturedCuts).toEqual([]);
});

test('startFresh resumes a parked replica and waits for first complete state', async () => {
	let didReset = false;
	let isReady = false;
	const { supervisor, flushTasks } = setup({
		isReady: () => isReady,
		startFreshLineage() {
			didReset = true;
		},
		synchronizeOnce() {
			if (!didReset) {
				return Promise.resolve({
					outcome: 'recovery-required',
					reason: 'lineage-mismatch',
				});
			}
			isReady = true;
			return Promise.resolve({ outcome: 'caught-up' });
		},
	});
	await flushAsyncWork(flushTasks);

	const recovered = supervisor.startFresh();
	await flushAsyncWork(flushTasks);
	await expect(recovered).resolves.toBeUndefined();
	expect(didReset).toBe(true);
	expect(supervisor.status).toEqual({ phase: 'caught-up' });
});

test('upgrade requirement reports reactively and parks all future networking', async () => {
	const { supervisor, onceCalls, capturedCuts, flushTasks, getTimerDelays } =
		setup({
			synchronizeOnce() {
				return Promise.resolve({ outcome: 'upgrade-required' });
			},
		});
	const statuses: WorkspaceSyncStatus[] = [];
	supervisor.onStatusChange((status) => statuses.push(status));
	await flushAsyncWork(flushTasks);

	expect(supervisor.status).toEqual({ phase: 'upgrade-required' });
	expect(statuses).toEqual([{ phase: 'upgrade-required' }]);
	expect(getTimerDelays()).toEqual([]);
	supervisor.wake();
	supervisor.notifyOnline();
	await expect(supervisor.settle()).resolves.toEqual({
		outcome: 'upgrade-required',
	});
	await flushAsyncWork(flushTasks);

	expect(onceCalls).toHaveLength(1);
	expect(capturedCuts).toEqual([]);
});

test('fatal driver error rejects settle and invokes the fatal hook', async () => {
	const failure = new Error('SQLite write failed');
	const { supervisor, setAdmissionCut, fatalCauses, flushTasks } = setup({
		synchronizeThrough() {
			return Promise.reject(failure);
		},
	});
	await flushAsyncWork(flushTasks);
	setAdmissionCut(2);

	const settlement = supervisor.settle();
	await flushAsyncWork(flushTasks);

	await expect(settlement).rejects.toBe(failure);
	expect(fatalCauses).toEqual([failure]);
});

test('dispose clears timers and rejects active settlement', async () => {
	const active = deferred<CanonicalSyncDriverResult>();
	const {
		supervisor,
		setAdmissionCut,
		throughCalls,
		flushTasks,
		getTimerDelays,
	} = setup({
		synchronizeThrough() {
			return active.promise;
		},
	});
	await flushAsyncWork(flushTasks);
	setAdmissionCut(4);
	const settlement = supervisor.settle();
	flushTasks();
	await Promise.resolve();
	expect(throughCalls).toEqual([4]);

	let isDisposed = false;
	const disposal = supervisor.dispose().then(() => {
		isDisposed = true;
	});
	await expect(settlement).rejects.toThrow(
		'Canonical sync supervisor is disposed',
	);
	expect(getTimerDelays()).toEqual([]);
	await Promise.resolve();
	expect(isDisposed).toBe(false);

	active.resolve({ outcome: 'caught-up' });
	await disposal;
	expect(isDisposed).toBe(true);
	await flushAsyncWork(flushTasks);
	supervisor.wake();
	await flushAsyncWork(flushTasks);
	expect(throughCalls).toEqual([4]);
});

test('dispose cancels a scheduled retry', async () => {
	const { supervisor, flushTasks, getTimerDelays } = setup({
		synchronizeOnce() {
			return Promise.resolve({ outcome: 'pending', reason: 'offline' });
		},
	});
	await flushAsyncWork(flushTasks);
	expect(getTimerDelays()).toContain(100);

	await supervisor[Symbol.asyncDispose]();
	expect(getTimerDelays()).toEqual([]);
});

test('settle after disposal rejects without touching replica state', async () => {
	const { supervisor, capturedCuts, flushTasks } = setup();
	await flushAsyncWork(flushTasks);
	await supervisor.dispose();

	await expect(supervisor.settle()).rejects.toThrow(
		'Canonical sync supervisor is disposed',
	);
	expect(capturedCuts).toEqual([]);
});
