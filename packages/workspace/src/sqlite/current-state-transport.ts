import type {
	CanonicalSyncDriverResult,
	CanonicalSyncSupervisorDriver,
	WorkspaceSyncPendingReason,
} from './canonical-sync-supervisor.js';

/**
 * A known interruption of authority transport.
 *
 * Transport implementations throw this only when retrying the same operation
 * is safe. Protocol parsing, local storage, and programming failures remain
 * ordinary errors and therefore reach the runtime's fatal-error hook.
 */
export class CurrentStateTransportInterruption extends Error {
	override readonly name = 'CurrentStateTransportInterruption';

	constructor(
		readonly reason: WorkspaceSyncPendingReason,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

/** Adapt only explicitly classified transport failures into retryable status. */
export function classifyCurrentStateTransport(
	driver: CanonicalSyncSupervisorDriver,
): CanonicalSyncSupervisorDriver {
	async function classify(
		operation: () => Promise<CanonicalSyncDriverResult>,
	): Promise<CanonicalSyncDriverResult> {
		try {
			return await operation();
		} catch (cause) {
			if (cause instanceof CurrentStateTransportInterruption) {
				return { outcome: 'pending', reason: cause.reason };
			}
			throw cause;
		}
	}

	return {
		captureAdmissionCut: driver.captureAdmissionCut,
		captureRecovery: driver.captureRecovery,
		isReady: driver.isReady,
		startFreshLineage: driver.startFreshLineage,
		synchronizeOnce: () => classify(driver.synchronizeOnce),
		synchronizeThrough: (cut) => classify(() => driver.synchronizeThrough(cut)),
	};
}
