/**
 * What a recorded publish attempt's `status` MEANS, owned in one place for both
 * sides of the wire.
 *
 * Deliberately not a state machine. There are no transitions here and nothing
 * decides what may follow what: TikTok owns the lifecycle of a publishing task,
 * and the attempt row stores TikTok's own code verbatim. This module answers
 * only the two questions both the Worker and the dashboard have to agree on:
 *
 * 1. Is this status TERMINAL, so polling stops and the durable row is final?
 * 2. What do we CALL it in front of a creator?
 *
 * Both answers live beside the codes they describe rather than in a Svelte
 * handler, because a client that invents its own terminal set is a client that
 * either polls a finished task forever or stops on a task still in flight.
 */

import type { TikTokPostStatusCode } from './api.js';

/**
 * Statuses that describe a LOCAL failure, used only where TikTok never gave us
 * one of its own codes to store.
 *
 * These are not alternative names for TikTok states. Each one records something
 * that happened on Epicenter's side of the call, which is exactly the
 * information TikTok's vocabulary cannot express.
 */
export type LocalAttemptStatus =
	/** TikTok understood `video/init` and definitively refused it, so no task exists. */
	| 'INIT_FAILED'
	/**
	 * `video/init` may or may not have created a task, and we cannot see which.
	 * Never retried; resolved by reading remote status.
	 */
	| 'INIT_AMBIGUOUS'
	/** The task exists and the bytes may not have landed. */
	| 'UPLOAD_FAILED';

/**
 * Every value the `status` column can hold, which is what makes this module the
 * vocabulary's owner rather than a description of it: `recordAttemptOutcome`
 * accepts this type, so a status invented at a call site is a type error.
 *
 * `null` is the fourth possibility and means the row was claimed but
 * `video/init` was never reached.
 */
export type AttemptStatus = TikTokPostStatusCode | LocalAttemptStatus;

/**
 * Statuses after which nothing will change on its own, so polling must stop.
 *
 * `INIT_AMBIGUOUS` and `UPLOAD_FAILED` are deliberately NOT terminal: both mean
 * a task may exist at TikTok, and that task is exactly what remote status can
 * still resolve. Treating them as final is how a real post ends up recorded as
 * a failure.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<AttemptStatus>([
	'PUBLISH_COMPLETE',
	'FAILED',
	'SEND_TO_USER_INBOX',
	'INIT_FAILED',
]);

/**
 * Whether this attempt has settled. An unrecognized status is treated as NOT
 * terminal, so a code this build has never seen keeps being polled rather than
 * being silently declared finished.
 */
export function isTerminalAttemptStatus(status: string | null): boolean {
	return status !== null && TERMINAL_STATUSES.has(status);
}

/**
 * How an attempt reads to the creator: what to call it, and how confident that
 * answer is.
 *
 * `tone` is the honest confidence, and the UI styles from it rather than from
 * the code, so a new status cannot arrive looking like a success:
 *
 * - `pending`: still moving. Nothing is decided.
 * - `posted`: TikTok says the post is live.
 * - `failed`: TikTok definitively did not post it.
 * - `unknown`: it may or may not have posted, and only TikTok can say.
 */
export type AttemptTone = 'pending' | 'posted' | 'failed' | 'unknown';

export type AttemptDescription = {
	label: string;
	tone: AttemptTone;
	/** One sentence telling the creator what, if anything, to do. */
	detail: string;
};

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
				label: 'Not sent',
				tone: 'unknown',
				detail:
					'Epicenter recorded this post but never reached TikTok. Nothing was published.',
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
				detail:
					'Epicenter could not tell whether TikTok accepted this post. Check this account in the TikTok app before posting again.',
			};
		case 'UPLOAD_FAILED':
			return {
				label: 'Outcome unknown',
				tone: 'unknown',
				detail:
					'TikTok created the post but the video may not have finished uploading. Check status, or check this account in the TikTok app.',
			};
		default:
			return {
				label: `Unrecognized status (${status})`,
				tone: 'unknown',
				detail:
					'TikTok reported a status this version does not recognize. Check this account in the TikTok app.',
			};
	}
}
