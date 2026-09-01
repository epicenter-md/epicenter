/**
 * Who may run a reconcile pass for one account.
 *
 * This used to be a lock file under the account's directory, because the writers
 * were separate processes: a CLI watch loop, an MCP server, and a desktop host.
 * There are no separate processes any more (ADR-0317). The writers are a visible
 * window and, on the desktop, a hidden synchronization worker, and neither of
 * them can see the other's memory or take the other's file lock in any way that
 * would still be honest.
 *
 * So the claim shrank to what it can actually promise: one pass at a time within
 * one surface. That is the case that used to go wrong by accident, and the type
 * still refuses it, because `reconcileAccount` requires a claim and only this
 * module mints one.
 *
 * **What is deliberately not promised.** Two surfaces reconciling one account at
 * the same moment. What protects that is not a claim but the shape of the work:
 * a label modify and a trash transition are idempotent at Gmail, an assertion is
 * retired only against the sequence a delivery actually proved, and a cache
 * write that loses the database lock reports `MirrorBusy` and retries on the
 * next pass. A cross-surface lock would need a durable owner with a lease and a
 * recovery story for a window that closed mid-pass, and nothing has asked for
 * one.
 */

/** Proof the holder is this account's reconciler for the length of one pass. */
export type ReconcileClaim = {
	readonly accountId: string;
};

export type ReconcileClaimBusy = {
	name: 'ReconcileClaimBusy';
	message: string;
	accountId: string;
};

const claimed = new Set<string>();

/**
 * Take the claim for `accountId`, or report that a pass is already running.
 *
 * The release is what the caller holds rather than a method on the claim, so
 * `finally` is the only place it can be spelled and a claim cannot outlive the
 * pass by being passed around.
 */
export function claimReconcile(
	accountId: string,
):
	| { claim: ReconcileClaim; release: () => void; error: null }
	| { claim: null; release: null; error: ReconcileClaimBusy } {
	if (claimed.has(accountId)) {
		return {
			claim: null,
			release: null,
			error: {
				name: 'ReconcileClaimBusy',
				message: 'A reconcile pass is already running for this account.',
				accountId,
			},
		};
	}
	claimed.add(accountId);
	return {
		claim: { accountId },
		release: () => claimed.delete(accountId),
		error: null,
	};
}
