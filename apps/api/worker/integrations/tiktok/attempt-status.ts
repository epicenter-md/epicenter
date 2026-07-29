/**
 * What a recorded publish attempt's `status` MEANS, owned in one place for both
 * sides of the wire.
 *
 * Deliberately not a state machine. There are no transitions here and nothing
 * decides what may follow what: TikTok owns the lifecycle of a publishing task,
 * and the attempt row stores TikTok's own code verbatim. This module answers
 * only the questions the Worker and the dashboard have to agree on:
 *
 * 1. Is this status TERMINAL, so polling stops and the durable row is final?
 * 2. Does it BLOCK a new publish, or block disconnecting the account?
 * 3. Can it be resolved by asking TikTok, or does it need a human?
 * 4. What do we CALL it in front of a creator?
 *
 * Every one of those answers lives beside the codes it describes rather than in
 * a Svelte handler, because each is a safety judgement about an irreversible
 * action. A client that decides for itself which statuses are terminal either
 * polls a finished task forever or abandons a post still in flight; a client
 * that decides for itself what blocks publishing can let one creator consent
 * produce two posts.
 *
 * THE INVARIANT everything here serves: one explicit creator consent creates at
 * most one Direct Post, and any outcome that MAY have committed stays visible
 * and blocks another publish until it is explicitly and honestly resolved.
 */

import type { TikTokPostStatusCode } from './api.js';

/**
 * Statuses that describe something on EPICENTER's side of the call, used where
 * TikTok never gave us one of its own codes to store.
 *
 * These are not alternative names for TikTok states. Each records information
 * TikTok's vocabulary cannot express.
 */
export type LocalAttemptStatus =
	/** TikTok understood `video/init` and definitively refused it, so no task exists. */
	| 'INIT_FAILED'
	/**
	 * `video/init` may or may not have created a task, and there is NO publish id
	 * to ask about, because the call that would have returned one is the call that
	 * failed. This is the one outcome nothing automated can ever resolve.
	 */
	| 'INIT_AMBIGUOUS'
	/** The task exists, and the bytes may not have landed. A publish id IS held. */
	| 'UPLOAD_FAILED'
	/**
	 * A HUMAN checked TikTok and recorded that the post is there. Deliberately
	 * distinct from `PUBLISH_COMPLETE`, which is TikTok's own word: this one is an
	 * assertion by the creator and must never be presented as provider truth.
	 */
	| 'RESOLVED_POSTED'
	/** A human checked TikTok and recorded that nothing was posted. */
	| 'RESOLVED_NOT_POSTED';

/**
 * Every value the `status` column can hold, which is what makes this module the
 * vocabulary's owner rather than a description of it: the store's writers accept
 * this type, so a status invented at a call site is a type error.
 *
 * `null` is the further possibility, and it is NOT "nothing happened": see
 * {@link describeAttemptStatus}.
 */
export type AttemptStatus = TikTokPostStatusCode | LocalAttemptStatus;

/** The two statuses a creator can record by hand, and nothing else. */
export const MANUAL_RESOLUTIONS = [
	'RESOLVED_POSTED',
	'RESOLVED_NOT_POSTED',
] as const;
export type ManualResolution = (typeof MANUAL_RESOLUTIONS)[number];

export function isManualResolution(value: unknown): value is ManualResolution {
	return (MANUAL_RESOLUTIONS as readonly unknown[]).includes(value);
}

/**
 * Statuses after which nothing will change on its own, so polling stops and the
 * durable row is final.
 *
 * `INIT_AMBIGUOUS` and `UPLOAD_FAILED` are deliberately absent: both mean a task
 * may exist at TikTok, and recording either as final is how a real post ends up
 * remembered as a failure.
 */
export const TERMINAL_ATTEMPT_STATUSES = [
	'PUBLISH_COMPLETE',
	'FAILED',
	'SEND_TO_USER_INBOX',
	'INIT_FAILED',
	'RESOLVED_POSTED',
	'RESOLVED_NOT_POSTED',
] as const satisfies readonly AttemptStatus[];

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<string>(
	TERMINAL_ATTEMPT_STATUSES,
);

/**
 * Statuses where TikTok has told us it holds the task and is working on it. We
 * can state exactly what happened, so these are known-committed rather than
 * unknown.
 */
export const PROCESSING_ATTEMPT_STATUSES = [
	'PROCESSING_UPLOAD',
	'PROCESSING_DOWNLOAD',
] as const satisfies readonly AttemptStatus[];

const PROCESSING_STATUSES: ReadonlySet<string> = new Set<string>(
	PROCESSING_ATTEMPT_STATUSES,
);

/**
 * Whether this attempt has settled. An unrecognized status is NOT terminal, so a
 * code this build has never seen keeps being treated as live rather than
 * silently declared finished.
 *
 * Two other rules are derived from this one rather than duplicated:
 *
 * - A same-key publish collision preserves the caller's idempotency claim unless
 *   the existing attempt is terminal (routes.ts).
 * - Disconnecting an account is refused while any attempt is non-terminal
 *   (routes.ts), because revoking the token would destroy custody of a task that
 *   may exist.
 */
export function isTerminalAttemptStatus(status: string | null): boolean {
	return status !== null && TERMINAL_STATUSES.has(status);
}

/**
 * Whether this attempt must stop the creator from publishing again.
 *
 * The block is for outcomes we cannot STATE, not merely unfinished ones. A post
 * TikTok is processing is known-committed: one consent made one post, and a
 * different post from a new consent is not a duplicate risk. An attempt whose
 * outcome is unknown is the opposite, and posting again is exactly the wrong
 * move.
 *
 * FAILS CLOSED. An unrecognized status is neither terminal nor known-processing,
 * so it blocks. "I do not know this word" is not evidence of safety when the
 * action is irreversible.
 */
export function blocksNewPublish(status: string | null): boolean {
	if (isTerminalAttemptStatus(status)) return false;
	return status === null || !PROCESSING_STATUSES.has(status);
}

/** The shape both predicates below need: a status plus whether a task is named. */
export type AttemptHandle = {
	status: string | null;
	publishId: string | null;
};

/**
 * Whether TikTok can still be asked about this attempt.
 *
 * Requires a publish id, because that id IS the task: `status/fetch` takes
 * nothing else. This is the distinction that makes `INIT_AMBIGUOUS` different in
 * kind from every other unresolved status.
 */
export function canReadRemoteStatus(attempt: AttemptHandle): boolean {
	return attempt.publishId !== null && !isTerminalAttemptStatus(attempt.status);
}

/**
 * Whether only a human can close this out, as a strict ALLOWLIST of the two
 * states that have no other exit.
 *
 * Reached by exactly two real paths. `INIT_AMBIGUOUS` is the init whose answer
 * was lost. A `null` status is a Worker that died between a successful init and
 * recording its publish id. In both, TikTok may be holding a post nobody can
 * name, so the creator looking and telling us is the only way out.
 *
 * Deliberately NOT "blocks publishing and has no publish id", which is what this
 * used to say and which was too permissive in two directions. It admitted
 * `UPLOAD_FAILED`, whose task IS named and therefore observable, and it admitted
 * any status this build does not recognize. Both would let somebody's assertion
 * overwrite state the provider can still be asked about, which is the one thing a
 * human resolution must never do. `store.ts` enforces the same allowlist in SQL,
 * so a caller cannot reach past this judgement.
 *
 * The `publishId === null` half is kept as well as the status allowlist: a row
 * that names a task can always be polled, and asking TikTok beats letting anyone
 * declare an answer.
 */
export function requiresManualResolution(attempt: AttemptHandle): boolean {
	if (attempt.publishId !== null) return false;
	return attempt.status === null || attempt.status === 'INIT_AMBIGUOUS';
}

/**
 * The newest attempt a surface should resume polling, or `null`.
 *
 * Rows arrive newest first. An attempt that blocks publishing but cannot be
 * polled is skipped here and handled by the block instead, so this never returns
 * something `follow()` would spin on forever.
 */
export function pickAttemptToFollow<T extends AttemptHandle>(
	attempts: readonly T[],
): T | null {
	return attempts.find((attempt) => canReadRemoteStatus(attempt)) ?? null;
}

/**
 * How an attempt reads to the creator: what to call it, and how confident that
 * answer is.
 *
 * `tone` is the honest confidence, and the UI styles from it rather than from the
 * code, so a new status cannot arrive looking like a success:
 *
 * - `pending`: still moving. Nothing is decided.
 * - `posted`: it is on the profile.
 * - `failed`: it definitively is not.
 * - `unknown`: it may or may not be, and only a look at TikTok can say.
 */
export type AttemptTone = 'pending' | 'posted' | 'failed' | 'unknown';

export type AttemptDescription = {
	label: string;
	tone: AttemptTone;
	/** One sentence telling the creator what, if anything, to do. */
	detail: string;
};

/** What to tell a creator whose only remedy is to look at TikTok themselves. */
const CHECK_TIKTOK =
	'Open the TikTok app to see whether it is on the profile, then record what you found.';

/**
 * The creator-facing reading of one attempt status.
 *
 * An unrecognized code falls through to `unknown` rather than to a friendly
 * default. Publishing is irreversible, so "we are not sure" is the only safe
 * thing to say about a state this build does not understand.
 */
export function describeAttemptStatus(
	status: string | null,
): AttemptDescription {
	switch (status) {
		case null:
			return {
				label: 'Outcome unknown',
				tone: 'unknown',
				/**
				 * NOT "nothing was published". The row is claimed BEFORE `video/init`,
				 * so a Worker that died after a successful init and before recording the
				 * publish id leaves exactly this row. There is no task id to ask about,
				 * which is why this cannot be resolved by checking status.
				 */
				detail: `Epicenter never recorded TikTok's answer for this post, so it may or may not have been created. ${CHECK_TIKTOK}`,
			};
		case 'PROCESSING_UPLOAD':
		case 'PROCESSING_DOWNLOAD':
			return {
				label: 'Processing at TikTok',
				tone: 'pending',
				detail:
					'TikTok is processing and reviewing this post. It can take a few minutes to appear on the profile.',
			};
		case 'PUBLISH_COMPLETE':
			return {
				label: 'Posted',
				tone: 'posted',
				detail: 'TikTok finished publishing this post.',
			};
		case 'SEND_TO_USER_INBOX':
			return {
				label: 'Sent to the TikTok inbox',
				tone: 'posted',
				detail:
					'TikTok placed this video in the account inbox instead of publishing it. Finish it in the TikTok app.',
			};
		case 'FAILED':
			return {
				label: 'TikTok could not post this',
				tone: 'failed',
				detail:
					'TikTok rejected this post. Nothing is on the profile, so it is safe to fix and post again.',
			};
		case 'INIT_FAILED':
			return {
				label: 'Refused before posting',
				tone: 'failed',
				detail:
					'TikTok refused this post before anything was created, so it is safe to fix and post again.',
			};
		case 'INIT_AMBIGUOUS':
			return {
				label: 'Outcome unknown',
				tone: 'unknown',
				/**
				 * Deliberately does NOT offer a status check. The failed call is the one
				 * that would have returned a publish id, so there is nothing to ask
				 * TikTok about. Telling the creator to "check status" here would send
				 * them at a button that cannot answer.
				 */
				detail: `Epicenter could not tell whether TikTok accepted this post, and no task id was returned to ask about. ${CHECK_TIKTOK}`,
			};
		case 'UPLOAD_FAILED':
			return {
				label: 'Outcome unknown',
				tone: 'unknown',
				// This one DOES hold a publish id, so checking status is a real remedy.
				detail:
					'TikTok created the post but the video may not have finished uploading. Check its status, or open the TikTok app.',
			};
		case 'RESOLVED_POSTED':
			return {
				label: 'Posted (you confirmed it)',
				tone: 'posted',
				detail:
					'You checked TikTok and recorded that this post is on the profile.',
			};
		case 'RESOLVED_NOT_POSTED':
			return {
				label: 'Not posted (you confirmed it)',
				tone: 'failed',
				detail:
					'You checked TikTok and recorded that nothing was posted, so it is safe to post again.',
			};
		default:
			return {
				label: `Unrecognized status (${status})`,
				tone: 'unknown',
				detail: `TikTok reported a status this version does not recognize. ${CHECK_TIKTOK}`,
			};
	}
}
