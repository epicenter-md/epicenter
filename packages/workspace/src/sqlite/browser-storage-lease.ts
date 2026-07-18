export type BrowserStorageLease = {
	release(): Promise<void>;
};

/**
 * Hold one origin-wide exclusive lease until its explicit release, or until a
 * newer owner steals it (newest tab wins).
 *
 * Opening the same workspace in a second tab must neither corrupt storage
 * (the SAH-pool VFS admits one live instance per directory) nor dead-end the
 * user: the newest acquisition steals the lock, the previous owner's
 * `onStolen` fires so it can close its database and release its access
 * handles, and the stolen tab degrades to loud per-operation failures instead
 * of a blank page.
 */
export async function acquireBrowserStorageLease(
	locks: LockManager,
	storageKey: string,
	{ onStolen = () => undefined }: { onStolen?: () => void } = {},
): Promise<BrowserStorageLease> {
	const acquired = Promise.withResolvers<BrowserStorageLease>();
	const released = Promise.withResolvers<void>();
	let isReleased = false;
	let isAcquired = false;
	const finishRelease = (): void => {
		if (isReleased) return;
		isReleased = true;
		released.resolve();
	};
	const completion = locks.request(
		`epicenter-sqlite-${storageKey}`,
		{ mode: 'exclusive', steal: true },
		async () => {
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
	// A steal by a newer owner rejects this request's promise with AbortError
	// even while the callback is still parked on `released`; unblock the
	// callback and tell the owner its storage moved.
	void completion.catch((cause) => {
		if (!isAcquired) {
			acquired.reject(cause);
			return;
		}
		const wasReleased = isReleased;
		finishRelease();
		if (!wasReleased) onStolen();
	});
	return acquired.promise;
}
