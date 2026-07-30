export type BrowserStorageLease = {
	release(): Promise<void>;
};

type LockManagerPort = {
	request(
		name: string,
		options: {
			mode: 'exclusive';
			ifAvailable: true;
		},
		callback: (lock: object | null) => Promise<void>,
	): Promise<void>;
};

/**
 * Retain the one exclusive Web Lock for this origin's OPFS SQLite owner.
 *
 * Dedicated workers can use synchronous OPFS, but two same-origin tabs cannot
 * safely own the same SQLite file. Refuse the second owner immediately instead
 * of leaving its application boot suspended behind the first tab's lifetime.
 *
 * `ifAvailable` makes this a one-shot claim: the lock is granted or the second
 * owner is told no, and it stays refused until someone reopens it after this
 * owner releases. Nothing steals the lock and nothing queues behind it, so
 * there is no handoff to observe while a lease is held.
 */
export async function acquireBrowserStorageLease(
	locks: LockManagerPort,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<BrowserStorageLease> {
	signal?.throwIfAborted();
	const acquired = Promise.withResolvers<BrowserStorageLease>();
	const released = Promise.withResolvers<void>();
	let isAcquired = false;
	let isReleased = false;

	function finishRelease(): void {
		if (isReleased) return;
		isReleased = true;
		released.resolve();
	}

	const completion = locks.request(
		'epicenter-data-sqlite',
		{ mode: 'exclusive', ifAvailable: true },
		async (lock) => {
			signal?.throwIfAborted();
			if (lock === null) {
				throw new Error(
					'Browser Epicenter is already open in another tab for this origin',
				);
			}
			isAcquired = true;
			acquired.resolve(
				Object.freeze({
					async release() {
						finishRelease();
						await completion.catch(() => undefined);
					},
				}),
			);
			await released.promise;
		},
	);

	void completion.catch((cause) => {
		// Refusal and abort both land here before the lease exists. Once acquired,
		// only `release()` ends the callback, so there is no later failure to
		// report to a caller that already holds the lease.
		if (!isAcquired) acquired.reject(cause);
		finishRelease();
	});
	return acquired.promise;
}

export type { LockManagerPort };
