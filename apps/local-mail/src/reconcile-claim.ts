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
 * write that loses the database lock reports `CacheBusy` and retries on the
 * next pass. A cross-surface lock would need a durable owner with a lease and a
 * recovery story for a window that closed mid-pass, and nothing has asked for
 * one.
 */

import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

/** Proof the holder is this account's reconciler for the length of one pass. */
export type ReconcileClaim = {
	readonly accountId: string;
};

export const ReconcileClaimError = defineErrors({
	Busy: ({ accountId }: { accountId: string }) => ({
		message: 'A reconcile pass is already running for this account.',
		accountId,
	}),
});
export type ReconcileClaimError = InferErrors<typeof ReconcileClaimError>;

/**
 * What a caller holds for the length of one pass: the proof, and the way to
 * give it back.
 *
 * The release is not a method on the claim. A claim is passed to
 * `reconcileAccount`, and a release travelling with it is a release the callee
 * could call; keeping them apart means `finally` at the call site is the only
 * place a pass can end.
 */
export type HeldClaim = {
	claim: ReconcileClaim;
	release: () => void;
};

const claimed = new Set<string>();

/** Take the claim for `accountId`, or report that a pass is already running. */
export function claimReconcile(
	accountId: string,
): Result<HeldClaim, ReconcileClaimError> {
	if (claimed.has(accountId)) {
		return ReconcileClaimError.Busy({ accountId });
	}
	claimed.add(accountId);
	return Ok({
		claim: { accountId },
		release: () => claimed.delete(accountId),
	});
}
