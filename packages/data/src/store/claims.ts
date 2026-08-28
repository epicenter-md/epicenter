/**
 * Which durable documents are currently held open, in this realm and across
 * this origin.
 *
 * Two opens of one document would be two `Y.Doc`s of it that cannot see each
 * other's writes, converging through storage under last-writer-wins: work
 * disappears, converged, with no error and nothing to retry. Refusing the
 * second open makes that unreachable rather than something a caller must avoid,
 * which is the move ADR-0216 made against the chosen-id door.
 *
 * The key is the durable document's own address, which is what makes the guard
 * exact. On Bun that is the databaseId, because an application folder holds one
 * document; in a browser it is the ownership path
 * `epicenter/<databaseId>/local` or
 * `epicenter/<databaseId>/account/<base URL>/<principal id>` (ADR-0261), so an
 * application's device document and one account's replica may be
 * open at once, two accounts' replicas may be open at once, and a second open
 * of any one of them is still refused.
 *
 * A lifecycle here is legitimate under ADR-0203 rather than a platform forming:
 * one file and one document with two claimants is genuinely contended. It holds
 * lock releases rather than handles, and disposing a store releases its entry.
 *
 * It used to be a module-level `Set`, and that was never enough. A `Set` is per
 * JavaScript realm, so two browser tabs of one application each got their own,
 * both claims succeeded, and the failure this module exists to prevent was
 * reachable the whole time on any origin a person can open twice.
 *
 * One mechanism, not two. An exclusive Web Lock cannot be re-granted while it
 * is held, not even to the context holding it, so it already answers the
 * same-realm case the `Set` was answering. Keeping both would be two guards
 * over one invariant, free to disagree, which is the shape this codebase has
 * been paying for elsewhere.
 *
 * It lives beside the openers rather than inside one because both of them need
 * it and neither owns it.
 */
import { Ok, type Result } from 'wellcrafted/result';

import { StoreError } from './store.js';

/**
 * The slice of the Web Locks API this needs, declared rather than imported.
 *
 * This module is typechecked without the DOM library, unlike `browser.ts`
 * which is excluded from the program for exactly that reason. Naming the two
 * calls it makes keeps the guard reachable from a module that has to compile
 * under `types: ["bun"]`, and keeps it honest: what is written here is the
 * whole of what is assumed about the platform.
 */
type LockManager = {
	request(
		name: string,
		options: { mode: 'exclusive'; ifAvailable: true },
		callback: (lock: unknown) => Promise<void> | undefined,
	): Promise<unknown>;
};

function lockManager(): LockManager | undefined {
	return (globalThis as { navigator?: { locks?: LockManager } }).navigator
		?.locks;
}

/** How to let go of the lock for an address this realm holds. */
const originLocks = new Map<string, () => void>();

/**
 * Claim a durable document, or report that it is already held.
 *
 * `ifAvailable` rather than queueing, deliberately. Refusing keeps the shape
 * every caller already handles, a `Result` that resolves either way. Waiting
 * for the other tab to close is a better experience and a different decision:
 * it makes an open able to hang, which no caller is written for today.
 *
 * A runtime with no `navigator.locks` is refused rather than let through. The
 * alternative is opening unguarded, which is the corruption this module
 * exists to prevent, arriving quietly on whatever runtime happens to lack the
 * API. Every browser this store targets ships it; a test runtime supplies it
 * the same way it supplies `indexedDB` (`test-locks.ts`).
 */
export async function claimDocument(
	address: string,
): Promise<Result<void, StoreError>> {
	const locks = lockManager();
	if (locks === undefined) {
		return StoreError.AlreadyOpen({ address });
	}

	return await new Promise<Result<void, StoreError>>((settle) => {
		void locks
			.request(
				lockName(address),
				{ mode: 'exclusive', ifAvailable: true },
				(lock) => {
					if (lock === null) {
						settle(StoreError.AlreadyOpen({ address }));
						return undefined;
					}
					settle(Ok(undefined));
					// The lock is held for exactly as long as this promise is
					// pending, so the resolver IS the release. It is kept beside the
					// address rather than returned, so `releaseDocument` keeps the
					// signature its call sites already use.
					return new Promise<void>((release) => {
						originLocks.set(address, release);
					});
				},
			)
			// A failed request must not leave the open awaiting a promise nobody
			// will settle.
			.catch(() => settle(StoreError.AlreadyOpen({ address })));
	});
}

/**
 * Namespaced so this cannot collide with a lock any other part of the origin
 * takes. Every Epicenter app shares one origin (ADR-0118), so the name has to
 * carry the address rather than assume it is alone.
 */
function lockName(address: string): string {
	return `epicenter.store:${address}`;
}

/** Release an address. Idempotent, because disposal is. */
export function releaseDocument(address: string): void {
	const release = originLocks.get(address);
	if (release !== undefined) {
		originLocks.delete(address);
		release();
	}
}
