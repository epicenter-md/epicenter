export type BrowserStorageLease = {
	release(): Promise<void>;
};

/** Hold one origin-wide exclusive lease until its explicit release. */
export async function acquireBrowserStorageLease(
	locks: LockManager,
	storageKey: string,
): Promise<BrowserStorageLease> {
	const acquired = Promise.withResolvers<BrowserStorageLease>();
	const released = Promise.withResolvers<void>();
	let isReleased = false;
	let completion: Promise<unknown>;
	completion = locks.request(
		`epicenter-sqlite-${storageKey}`,
		{ mode: 'exclusive', ifAvailable: true },
		async (lock) => {
			if (!lock) {
				acquired.reject(
					new Error(`Workspace storage already has an owner: ${storageKey}`),
				);
				return;
			}
			acquired.resolve(
				Object.freeze({
					async release() {
						if (!isReleased) {
							isReleased = true;
							released.resolve();
						}
						await completion;
					},
				}),
			);
			await released.promise;
		},
	);
	void completion.catch((cause) => acquired.reject(cause));
	return acquired.promise;
}
