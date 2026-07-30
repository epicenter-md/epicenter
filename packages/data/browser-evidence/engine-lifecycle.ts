export type EvidenceEngineLifecycle = ReturnType<
	typeof createEvidenceEngineLifecycle
>;

export function createEvidenceEngineLifecycle(
	closeContext: () => Promise<void>,
	forceClose: () => Promise<void> = closeContext,
	closeTimeoutMs = 5_000,
) {
	let stoppedReason: string | undefined;
	let closePromise: Promise<void> | undefined;
	return Object.freeze({
		recordCellFailure({
			reason,
			unsupported,
			deadline,
		}: {
			reason: string;
			unsupported: boolean;
			deadline: boolean;
		}): 'failed' | 'unsupported' {
			if (deadline || !unsupported) stoppedReason ??= reason;
			return unsupported ? 'unsupported' : 'failed';
		},
		stoppedReason(): string | undefined {
			return stoppedReason;
		},
		close(): Promise<void> {
			closePromise ??= closeWithFallback(
				closeContext,
				forceClose,
				closeTimeoutMs,
			);
			return closePromise;
		},
	});
}

async function closeWithFallback(
	closeContext: () => Promise<void>,
	forceClose: () => Promise<void>,
	timeoutMs: number,
): Promise<void> {
	try {
		await closeWithinDeadline(closeContext, timeoutMs, 'cleanup');
	} catch (closeError) {
		try {
			await closeWithinDeadline(forceClose, timeoutMs, 'forced cleanup');
		} catch (forceError) {
			throw new AggregateError(
				[closeError, forceError],
				'Browser context cleanup and forced cleanup both failed',
			);
		}
		throw closeError;
	}
}

async function closeWithinDeadline(
	closeContext: () => Promise<void>,
	timeoutMs: number,
	label: string,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.resolve().then(closeContext),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(`Browser context ${label} exceeded ${timeoutMs}ms`),
						),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
