/**
 * The synchronization lifecycle for one open canonical workspace.
 *
 * The replica owns protocol progress. This supervisor owns when to ask the
 * replica to make progress, how transient interruption is retried, and which
 * fixed admission cut each explicit settlement call is waiting for.
 */
import type { LogicalWorkspaceCopy } from './canonical-addition.js';

export type WorkspaceSyncPendingReason =
	| 'offline'
	| 'retrying'
	| 'authentication'
	| 'storage-limit';

export type WorkspaceSyncRecoveryReason = 'lineage-mismatch';

export type WorkspaceSyncStatus =
	| { phase: 'caught-up' }
	| { phase: 'syncing' }
	| { phase: 'pending'; reason: WorkspaceSyncPendingReason }
	| { phase: 'upgrade-required' }
	| {
			phase: 'recovery-required';
			reason: WorkspaceSyncRecoveryReason;
	  };

export type WorkspaceSyncSettlement =
	| { outcome: 'caught-up' }
	| { outcome: 'pending'; reason: WorkspaceSyncPendingReason }
	| { outcome: 'upgrade-required' }
	| {
			outcome: 'recovery-required';
			reason: WorkspaceSyncRecoveryReason;
	  };

export type WorkspaceSync = {
	readonly status: WorkspaceSyncStatus;
	/** Observe future status changes. Read `status` for the current value. */
	onStatusChange(listener: (status: WorkspaceSyncStatus) => void): () => void;
	/** Settle the local admission watermark captured synchronously by this call. */
	settle(): Promise<WorkspaceSyncSettlement>;
	/** Capture visible user content only after synchronization stops for recovery. */
	captureRecovery(): Promise<LogicalWorkspaceCopy | null>;
	/** Discard halted private sync state and acquire one fresh authority lineage. */
	startFresh(): Promise<void>;
};

/** INTERNAL: fixed-cut controls used only by the workspace runtime wrapper. */
export type WorkspaceOwnerSync = WorkspaceSync & {
	/** Capture the latest local admission sequence without yielding. */
	captureAdmissionCut(): number;
	/** Settle one previously captured admission sequence. */
	settleThrough(cut: number): Promise<WorkspaceSyncSettlement>;
	/** Wait until the first complete authority state has been installed. */
	whenReady(): Promise<void>;
};

export type CanonicalSyncDriverResult =
	| { outcome: 'progress' }
	| { outcome: 'caught-up' }
	| { outcome: 'pending'; reason: WorkspaceSyncPendingReason }
	| { outcome: 'upgrade-required' }
	| {
			outcome: 'recovery-required';
			reason: WorkspaceSyncRecoveryReason;
	  };

export type CanonicalSyncSupervisorDriver = {
	/** Capture the latest authored local admission sequence without yielding. */
	captureAdmissionCut(): number;
	/** Advance ordinary background synchronization by one bounded step. */
	synchronizeOnce(): Promise<CanonicalSyncDriverResult>;
	/** Advance one fixed caller watermark by one bounded step. */
	synchronizeThrough(cut: number): Promise<CanonicalSyncDriverResult>;
	/** Capture logical visible content after a lineage halt. */
	captureRecovery(): LogicalWorkspaceCopy | null;
	/** Whether one complete authority state has been installed. */
	isReady(): boolean;
	/** Reset a recovery-halted replica to one empty, unregistered lineage. */
	startFreshLineage(): void;
};

type Timer = ReturnType<typeof setTimeout>;

type CanonicalSyncScheduler = {
	queueTask(task: () => void): void;
	setTimer(task: () => void, delayMs: number): Timer;
	clearTimer(timer: Timer): void;
};

type CanonicalSyncSupervisorOptions = {
	driver: CanonicalSyncSupervisorDriver;
	onFatal(cause: unknown): void;
	onStatusObserverError?(cause: unknown): void;
	pollIntervalMs?: number;
	retryBaseDelayMs?: number;
	retryMaxDelayMs?: number;
	random?: () => number;
	scheduler?: CanonicalSyncScheduler;
};

type SettlementWaiter = {
	cut: number;
	resolve(settlement: WorkspaceSyncSettlement): void;
	reject(cause: unknown): void;
};

type ReadinessWaiter = {
	resolve(): void;
	reject(cause: unknown): void;
};

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

const defaultScheduler: CanonicalSyncScheduler = {
	// Wrapped so the method call `scheduler.queueTask(...)` never invokes the
	// native function with the scheduler as `this` (Chromium throws
	// "Illegal invocation" on a non-global receiver; Bun does not).
	queueTask: (task) => queueMicrotask(task),
	setTimer(task, delayMs) {
		const timer = setTimeout(task, delayMs);
		// Node/Bun timers expose unref; browser timers are numbers. The cast
		// avoids a DOM-lib narrowing trap (`'unref' in timer` narrows number
		// to never in browser-typed programs).
		(timer as unknown as { unref?: () => void }).unref?.();
		return timer;
	},
	clearTimer: clearTimeout,
};

export function createCanonicalSyncSupervisor({
	driver,
	onFatal,
	onStatusObserverError,
	pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
	retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
	retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
	random = Math.random,
	scheduler = defaultScheduler,
}: CanonicalSyncSupervisorOptions) {
	let status: WorkspaceSyncStatus = { phase: 'syncing' };
	let isDisposed = false;
	let isParked = false;
	let isRunning = false;
	let isRunQueued = false;
	let isBackgroundRequested = true;
	let activeRun: Promise<void> | undefined;
	let disposal: Promise<void> | undefined;
	let retryAttempt = 0;
	let retryTimer: Timer | undefined;
	let pollTimer: Timer | undefined;
	const statusListeners = new Set<(next: WorkspaceSyncStatus) => void>();
	const settlementWaiters: SettlementWaiter[] = [];
	const readinessWaiters: ReadinessWaiter[] = [];

	function resolveReadiness(): void {
		if (!driver.isReady()) return;
		const waiters = readinessWaiters.splice(0);
		for (const waiter of waiters) waiter.resolve();
	}

	function rejectReadiness(cause: unknown): void {
		const waiters = readinessWaiters.splice(0);
		for (const waiter of waiters) waiter.reject(cause);
	}

	function setStatus(next: WorkspaceSyncStatus): void {
		if (
			status.phase === next.phase &&
			(status.phase !== 'pending' ||
				(next.phase === 'pending' && status.reason === next.reason)) &&
			(status.phase !== 'recovery-required' ||
				(next.phase === 'recovery-required' && status.reason === next.reason))
		) {
			return;
		}
		status = next;
		for (const listener of statusListeners) {
			try {
				listener(next);
			} catch (cause) {
				try {
					onStatusObserverError?.(cause);
				} catch {
					// Status observation is caller code and cannot stop synchronization.
				}
			}
		}
	}

	function clearRetryTimer(): void {
		if (retryTimer === undefined) return;
		scheduler.clearTimer(retryTimer);
		retryTimer = undefined;
	}

	function clearPollTimer(): void {
		if (pollTimer === undefined) return;
		scheduler.clearTimer(pollTimer);
		pollTimer = undefined;
	}

	function schedulePoll(): void {
		clearPollTimer();
		if (isDisposed || isParked) return;
		pollTimer = scheduler.setTimer(() => {
			pollTimer = undefined;
			wake();
			schedulePoll();
		}, pollIntervalMs);
	}

	function scheduleRetry(): void {
		if (isDisposed || isParked || retryTimer !== undefined) return;
		retryAttempt += 1;
		const exponentialDelay = Math.min(
			retryBaseDelayMs * 2 ** (retryAttempt - 1),
			retryMaxDelayMs,
		);
		const jitteredDelay = Math.min(
			exponentialDelay * (0.5 + random() * 0.5),
			retryMaxDelayMs,
		);
		retryTimer = scheduler.setTimer(() => {
			retryTimer = undefined;
			requestRun();
		}, jitteredDelay);
	}

	function oldestSettlementCut(): number | undefined {
		let oldest: number | undefined;
		for (const waiter of settlementWaiters) {
			if (oldest === undefined || waiter.cut < oldest) oldest = waiter.cut;
		}
		return oldest;
	}

	function resolveSettlementsThrough(cut: number): void {
		for (let index = settlementWaiters.length - 1; index >= 0; index -= 1) {
			const waiter = settlementWaiters[index];
			if (!waiter || waiter.cut > cut) continue;
			settlementWaiters.splice(index, 1);
			waiter.resolve({ outcome: 'caught-up' });
		}
	}

	function resolveAllSettlements(settlement: WorkspaceSyncSettlement): void {
		const waiters = settlementWaiters.splice(0);
		for (const waiter of waiters) waiter.resolve(settlement);
	}

	function rejectAllSettlements(cause: unknown): void {
		const waiters = settlementWaiters.splice(0);
		for (const waiter of waiters) waiter.reject(cause);
	}

	function parkForRecovery(reason: WorkspaceSyncRecoveryReason): void {
		isParked = true;
		isBackgroundRequested = false;
		clearRetryTimer();
		clearPollTimer();
		setStatus({ phase: 'recovery-required', reason });
		resolveAllSettlements({ outcome: 'recovery-required', reason });
		rejectReadiness(new Error('Workspace requires lineage recovery'));
	}

	function parkForUpgrade(): void {
		isParked = true;
		isBackgroundRequested = false;
		clearRetryTimer();
		clearPollTimer();
		setStatus({ phase: 'upgrade-required' });
		resolveAllSettlements({ outcome: 'upgrade-required' });
		rejectReadiness(new Error('Workspace protocol requires an upgrade'));
	}

	function handlePending(reason: WorkspaceSyncPendingReason): void {
		isBackgroundRequested = true;
		setStatus({ phase: 'pending', reason });
		resolveAllSettlements({ outcome: 'pending', reason });
		scheduleRetry();
	}

	async function run(): Promise<void> {
		if (isDisposed || isParked || isRunning || retryTimer !== undefined) return;
		isRunning = true;
		isRunQueued = false;
		setStatus({ phase: 'syncing' });
		try {
			while (!isDisposed && !isParked) {
				const settlementCut = oldestSettlementCut();
				if (settlementCut === undefined && !isBackgroundRequested) {
					setStatus({ phase: 'caught-up' });
					break;
				}

				if (settlementCut === undefined) isBackgroundRequested = false;
				const result =
					settlementCut === undefined
						? await driver.synchronizeOnce()
						: await driver.synchronizeThrough(settlementCut);
				if (isDisposed) break;

				switch (result.outcome) {
					case 'progress':
						continue;
					case 'caught-up':
						retryAttempt = 0;
						clearRetryTimer();
						if (settlementCut !== undefined) {
							resolveSettlementsThrough(settlementCut);
							continue;
						}
						setStatus({ phase: 'caught-up' });
						resolveReadiness();
						if (!isBackgroundRequested && settlementWaiters.length === 0) {
							break;
						}
						continue;
					case 'pending':
						handlePending(result.reason);
						return;
					case 'recovery-required':
						parkForRecovery(result.reason);
						return;
					case 'upgrade-required':
						parkForUpgrade();
						return;
					default:
						result satisfies never;
				}
			}
		} catch (cause) {
			if (!isDisposed) {
				isBackgroundRequested = false;
				rejectAllSettlements(cause);
				rejectReadiness(cause);
				try {
					onFatal(cause);
				} catch {
					// Reporting a fatal driver error cannot create another sync failure.
				}
			}
		} finally {
			isRunning = false;
			if (
				!isDisposed &&
				!isParked &&
				retryTimer === undefined &&
				(isBackgroundRequested || settlementWaiters.length > 0)
			) {
				requestRun();
			}
		}
	}

	function requestRun(): void {
		if (
			isDisposed ||
			isParked ||
			isRunning ||
			isRunQueued ||
			retryTimer !== undefined
		) {
			return;
		}
		isRunQueued = true;
		scheduler.queueTask(() => {
			isRunQueued = false;
			const pending = run();
			activeRun = pending;
			void pending.then(
				() => {
					if (activeRun === pending) activeRun = undefined;
				},
				() => {
					if (activeRun === pending) activeRun = undefined;
				},
			);
		});
	}

	function wake(): void {
		if (isDisposed || isParked) return;
		isBackgroundRequested = true;
		requestRun();
	}

	function notifyOnline(): void {
		if (isDisposed || isParked) return;
		clearRetryTimer();
		retryAttempt = 0;
		wake();
	}

	function captureAdmissionCut(): number {
		if (isDisposed) {
			throw new Error('Canonical sync supervisor is disposed');
		}
		return driver.captureAdmissionCut();
	}

	function settleThrough(cut: number): Promise<WorkspaceSyncSettlement> {
		if (!Number.isSafeInteger(cut) || cut < 0) {
			return Promise.reject(
				new TypeError('Admission cut must be a non-negative integer'),
			);
		}
		if (isDisposed) {
			return Promise.reject(new Error('Canonical sync supervisor is disposed'));
		}
		if (status.phase === 'recovery-required') {
			return Promise.resolve({
				outcome: 'recovery-required',
				reason: status.reason,
			});
		}
		if (status.phase === 'upgrade-required') {
			return Promise.resolve({ outcome: 'upgrade-required' });
		}
		if (status.phase === 'pending') {
			return Promise.resolve({
				outcome: 'pending',
				reason: status.reason,
			});
		}
		const promise = new Promise<WorkspaceSyncSettlement>((resolve, reject) => {
			settlementWaiters.push({ cut, resolve, reject });
		});
		requestRun();
		return promise;
	}

	function settle(): Promise<WorkspaceSyncSettlement> {
		if (isDisposed) {
			return Promise.reject(new Error('Canonical sync supervisor is disposed'));
		}
		if (status.phase === 'recovery-required') {
			return Promise.resolve({
				outcome: 'recovery-required',
				reason: status.reason,
			});
		}
		if (status.phase === 'upgrade-required') {
			return Promise.resolve({ outcome: 'upgrade-required' });
		}
		if (status.phase === 'pending') {
			return Promise.resolve({
				outcome: 'pending',
				reason: status.reason,
			});
		}
		try {
			return settleThrough(captureAdmissionCut());
		} catch (cause) {
			return Promise.reject(cause);
		}
	}

	function onStatusChange(
		listener: (next: WorkspaceSyncStatus) => void,
	): () => void {
		statusListeners.add(listener);
		return () => statusListeners.delete(listener);
	}

	function captureRecovery(): Promise<LogicalWorkspaceCopy | null> {
		if (isDisposed) {
			return Promise.reject(new Error('Canonical sync supervisor is disposed'));
		}
		return Promise.resolve(driver.captureRecovery());
	}

	function whenReady(): Promise<void> {
		if (isDisposed) {
			return Promise.reject(new Error('Canonical sync supervisor is disposed'));
		}
		if (driver.isReady()) return Promise.resolve();
		if (status.phase === 'recovery-required') {
			return Promise.reject(new Error('Workspace requires lineage recovery'));
		}
		if (status.phase === 'upgrade-required') {
			return Promise.reject(
				new Error('Workspace protocol requires an upgrade'),
			);
		}
		return new Promise<void>((resolve, reject) => {
			readinessWaiters.push({ resolve, reject });
			requestRun();
		});
	}

	async function startFresh(): Promise<void> {
		if (isDisposed) {
			throw new Error('Canonical sync supervisor is disposed');
		}
		if (status.phase !== 'recovery-required') {
			throw new Error('Workspace does not require lineage recovery');
		}
		await activeRun;
		driver.startFreshLineage();
		isParked = false;
		isBackgroundRequested = true;
		retryAttempt = 0;
		setStatus({ phase: 'syncing' });
		schedulePoll();
		requestRun();
		await whenReady();
	}

	function dispose(): Promise<void> {
		if (disposal) return disposal;
		isDisposed = true;
		isBackgroundRequested = false;
		clearRetryTimer();
		clearPollTimer();
		statusListeners.clear();
		rejectAllSettlements(new Error('Canonical sync supervisor is disposed'));
		rejectReadiness(new Error('Canonical sync supervisor is disposed'));
		disposal = activeRun ?? Promise.resolve();
		return disposal;
	}

	schedulePoll();
	requestRun();

	return {
		get status(): WorkspaceSyncStatus {
			return status;
		},
		onStatusChange,
		settle,
		captureRecovery,
		startFresh,
		captureAdmissionCut,
		settleThrough,
		whenReady,
		wake,
		notifyOnline,
		dispose,
		async [Symbol.asyncDispose]() {
			await dispose();
		},
	};
}

export type CanonicalSyncSupervisor = ReturnType<
	typeof createCanonicalSyncSupervisor
>;
