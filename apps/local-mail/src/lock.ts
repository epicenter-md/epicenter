import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { ensureAccountDir } from './paths.ts';

/**
 * The per-account reconcile-owner lock. The runtime invariant is: at most one
 * active reconciler per account, and the reconciler is the only thing that
 * writes to Gmail (ADR-0199), so this lock names the account's single writer
 * rather than just its single puller. Reads (`query`/`status`) open the mirror
 * read-only and triage acts only write the local intent store, so neither needs
 * it. The holders are the open desktop `app` (holds it for its whole lifetime
 * while its loop runs), a CLI `reconcile --watch` loop, and a one-shot act or
 * `reconcile` for the duration of its single pass.
 *
 * A dedicated `lock.db` held with `BEGIN EXCLUSIVE` is the lock: a second holder
 * fails to open the transaction instantly (`busy_timeout = 0`) and yields rather
 * than racing a second bulk pull. `flock` has no Bun API and an `O_EXCL` lockfile
 * is stale-on-crash; the fcntl lock a live SQLite transaction holds is released
 * by the kernel on `kill -9`, so a crashed owner never wedges the next pass.
 * SQLite tracks open connections per process, so this also refuses a second
 * in-process holder, not just a second process.
 */

/**
 * The capability's brand. Unexported and freshly minted, so no other module can
 * name it and therefore no other module can build a value of the type below.
 * Real at runtime rather than a `declare`d phantom, so the guarantee does not
 * evaporate wherever the types do: a plain object cast through `any` still fails
 * an `accountEmail` check but would pass a type-only brand silently.
 */
const RECONCILE_OWNER: unique symbol = Symbol('local-mail.reconcile-owner');

/**
 * Proof that the holder is the reconcile owner for ONE named account. It is a
 * capability, not a flag: a function that requires one cannot be called by a
 * caller who merely believes it has the right to write, which is what keeps
 * "exactly one writer per account" a property of the types rather than of every
 * call site remembering to take a lock first.
 *
 * `accountEmail` is on the lock because a process can hold several: the desktop
 * host serves every connected account at once. A pass checks the lock it was
 * handed against the account it is about to reconcile, so holding account A's
 * lock cannot authorize a write to account B.
 */
export type ReconcileLock = {
	readonly [RECONCILE_OWNER]: true;
	readonly accountEmail: string;
	release(): void;
};

/**
 * Try to become the reconcile owner for `<dataDir>/<accountEmail>`. Returns the
 * capability to hand to a pass and `release()` when the pass or loop ends, or
 * `null` when another owner (the open app, another pass) already holds it. The
 * account directory is created if missing so the very first pass after `connect`
 * can take the lock before the mirror db exists.
 *
 * This is the only way a `ReconcileLock` comes into existence, in production or
 * in a test, so a second reconciler is refused by the same mechanism everywhere.
 */
export function acquireReconcileLock({
	dataDir,
	accountEmail,
}: {
	dataDir: string;
	accountEmail: string;
}): ReconcileLock | null {
	const dir = ensureAccountDir(dataDir, accountEmail);
	const db = new Database(join(dir, 'lock.db'), { create: true });
	db.run('PRAGMA busy_timeout = 0;');
	try {
		db.run('BEGIN EXCLUSIVE;');
	} catch {
		db.close();
		return null;
	}
	return {
		[RECONCILE_OWNER]: true,
		accountEmail,
		release() {
			try {
				db.run('ROLLBACK;');
			} catch {
				// The process is exiting; the kernel drops the lock regardless.
			}
			db.close();
		},
	};
}

/**
 * What a pass yields when another owner already holds the lock. It exits
 * cleanly: nothing failed, and whoever owns the loop delivers the pending
 * assertions and keeps the mirror fresh.
 *
 * `local-mail reconcile --json` prints this on stdout, the MCP `reconcile` tool
 * returns it as `Ok`, and the HTTP route sends it as the body; the human CLI
 * prints its `message`. `reconciled: false` is the discriminant against a real
 * `ReconcileOutcome` (which has no `reconciled` field); `reason` is a stable
 * machine token; `message` is human.
 */
export type ReconcileOwnerBusy = {
	reconciled: false;
	reason: 'reconcile-owner-active';
	message: string;
};

export function reconcileOwnerBusy(accountEmail: string): ReconcileOwnerBusy {
	return {
		reconciled: false,
		reason: 'reconcile-owner-active',
		message: `Local Mail is already reconciling ${accountEmail} (the app is open, or another pass is running). Skipping; that owner delivers pending changes and keeps the mirror fresh.`,
	};
}
