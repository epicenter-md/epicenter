/**
 * Typed fetch client and query bindings for `/api/integrations/tiktok/*`.
 *
 * Types come from the sibling Worker (`$api/integrations/tiktok/*`), so the
 * dashboard and the routes it calls cannot drift apart. Every call rides
 * `auth.fetch`, which attaches the first-party session cookie; the browser
 * never holds a TikTok token, and no response it can receive contains one.
 */

import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { defineKeys } from 'wellcrafted/query';
import { Err, type Result, tryAsync } from 'wellcrafted/result';
import type {
	TikTokCreatorInfo,
	TikTokPostStatus,
	TikTokPrivacyLevel,
} from '$api/integrations/tiktok/api';
import type { ManualResolution } from '$api/integrations/tiktok/attempt-status';
import type { PublicConnection } from '$api/integrations/tiktok/store';
import { auth } from '$lib/platform/auth';
import { defineQuery } from '$lib/query/client';

export type { PublicConnection, TikTokCreatorInfo, TikTokPrivacyLevel };

export type ConnectionsView = {
	/** False when the deployment has no TikTok credentials configured. */
	configured: boolean;
	/**
	 * The exact value to register in the TikTok developer portal. Surfaced only
	 * in the unconfigured state, which is an operator problem rather than part of
	 * the creator's product.
	 */
	redirectUri: string;
	connections: PublicConnection[];
};

/**
 * One recorded publish, as it crosses the wire.
 *
 * Declared here rather than derived from the Drizzle row because the row's
 * timestamps are `Date` objects and JSON delivers strings. `status` is
 * deliberately a plain `string | null`: it holds TikTok's own code, and
 * `describeAttemptStatus` is what turns any of them (including one this build
 * has never seen) into something to show a creator.
 */
export type PublishAttempt = {
	id: string;
	connectionId: string;
	idempotencyKey: string;
	publishId: string | null;
	status: string | null;
	/**
	 * When the request that claimed this attempt stops being allowed to work on it.
	 *
	 * Needed on the client because it is what separates a publish healthily
	 * in flight from one whose Worker died: both look like `(publishId: null,
	 * status: null)`, and only the lease says which. The surface offers a manual
	 * outcome for the second and refuses to for the first.
	 */
	leaseExpiresAt: string | null;
	/**
	 * `null` until remote status has been read once; an empty array once TikTok
	 * has answered and named no public post.
	 */
	publicPostIds: string[] | null;
	failReason: string | null;
	createdAt: string;
};

/** Remote truth for one publishing task, plus whether it was recorded locally. */
export type PublishStatusView = TikTokPostStatus & {
	/**
	 * False in the one documented window where TikTok created the task but
	 * Epicenter never persisted its publish id, so this outcome is not being
	 * remembered.
	 */
	recorded: boolean;
};

export const TikTokApiError = defineErrors({
	RequestFailed: ({
		endpoint,
		cause,
	}: {
		endpoint: string;
		cause: unknown;
	}) => ({
		message: `Request to ${endpoint} failed: ${extractErrorMessage(cause)}`,
		endpoint,
		cause,
	}),
	/**
	 * The server answered with its own structured error envelope. Its message is
	 * written for the creator, so it is surfaced verbatim rather than replaced.
	 */
	ServerRefused: ({
		endpoint,
		status,
		message,
		code,
		unresolved,
		attemptId,
		publishId,
	}: {
		endpoint: string;
		status: number;
		message: string;
		code?: string;
		/**
		 * True when the server could not determine whether an irreversible publish
		 * took effect. The caller must NOT retry automatically; see
		 * PublishOutcomeUnknown in the Worker routes.
		 */
		unresolved?: boolean;
		attemptId?: string;
		publishId?: string | null;
	}) => ({
		message,
		endpoint,
		status,
		code,
		unresolved,
		attemptId,
		publishId,
	}),
});
export type TikTokApiError = import('wellcrafted/error').InferErrors<
	typeof TikTokApiError
>;

type TikTokResult<T> = Result<T, TikTokApiError>;

const BASE = '/api/integrations/tiktok';

/**
 * Read a response. Non-OK bodies carry `{ data: null, error: { message } }`
 * from the Worker's `defineErrors` envelope; anything else falls back to the
 * status so a failure is never rendered as success.
 */
async function readResponse<T>(
	endpoint: string,
	res: Response,
): Promise<TikTokResult<T>> {
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as {
			error?: {
				message?: string;
				code?: string;
				unresolved?: boolean;
				attemptId?: string;
				publishId?: string | null;
			};
			message?: string;
		} | null;
		return TikTokApiError.ServerRefused({
			endpoint,
			status: res.status,
			message:
				body?.error?.message ??
				body?.message ??
				`Request failed with ${res.status}.`,
			...(body?.error?.code ? { code: body.error.code } : {}),
			// Carried through verbatim so the caller can refuse an automatic retry.
			...(body?.error?.unresolved ? { unresolved: true } : {}),
			...(body?.error?.attemptId ? { attemptId: body.error.attemptId } : {}),
			...(body?.error?.publishId !== undefined
				? { publishId: body.error.publishId }
				: {}),
		});
	}
	return tryAsync({
		try: () => res.json() as Promise<T>,
		catch: (cause) => TikTokApiError.RequestFailed({ endpoint, cause }),
	});
}

async function send<T>(
	endpoint: string,
	init?: RequestInit,
): Promise<TikTokResult<T>> {
	const { data: res, error } = await tryAsync({
		try: () => auth.fetch(endpoint, init),
		catch: (cause) => TikTokApiError.RequestFailed({ endpoint, cause }),
	});
	if (error) return Err(error);
	return readResponse<T>(endpoint, res);
}

export const tiktokApi = {
	connections: () => send<ConnectionsView>(`${BASE}/connections`),

	/** Returns the TikTok consent URL to navigate to. */
	startConnect: (returnPath: string) =>
		send<{ url: string }>(`${BASE}/connect`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ returnPath }),
		}),

	/**
	 * Deleting locally and revoking at TikTok are different facts, and the
	 * response reports both so the UI can say which one actually happened.
	 */
	disconnect: (connectionId: string) =>
		send<{
			deletedLocally: boolean;
			revokedAtProvider: boolean;
			revokeFailure: string | null;
		}>(`${BASE}/connections/${connectionId}`, { method: 'DELETE' }),

	creatorInfo: (connectionId: string) =>
		send<TikTokCreatorInfo>(`${BASE}/connections/${connectionId}/creator-info`),

	attempts: (connectionId: string) =>
		send<{ attempts: PublishAttempt[] }>(
			`${BASE}/connections/${connectionId}/attempts`,
		),

	/**
	 * Remote truth for one publishing task. This is how an ambiguous publish is
	 * resolved, never a retry, and the same call reconciles the recorded attempt
	 * server-side so a reload cannot show a stale "processing".
	 */
	publishStatus: (connectionId: string, publishId: string) =>
		send<PublishStatusView>(
			`${BASE}/connections/${connectionId}/publish/${publishId}`,
		),

	/**
	 * Record what a creator found for an attempt that cannot be polled (no publish
	 * id exists). The server stores it as a HUMAN's assertion, distinct from
	 * TikTok's own status, and refuses to overwrite a status TikTok supplied since.
	 */
	resolveAttempt: (
		connectionId: string,
		attemptId: string,
		outcome: ManualResolution,
	) =>
		send<{ status: ManualResolution }>(
			`${BASE}/connections/${connectionId}/attempts/${attemptId}/resolve`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ outcome }),
			},
		),

	/**
	 * The form is sent as multipart so the video never has to be base64-inflated.
	 * `idempotencyKey` is required by the server: it is what makes a repeated
	 * submit unable to originate a second post.
	 */
	publish: (connectionId: string, form: FormData) =>
		send<{
			attemptId: string;
			publishId: string;
			message: string;
		}>(`${BASE}/connections/${connectionId}/publish`, {
			method: 'POST',
			body: form,
		}),
};

export const tiktokKeys = defineKeys({
	connections: ['tiktok', 'connections'],
});

export const tiktok = {
	connections: defineQuery({
		queryKey: tiktokKeys.connections,
		queryFn: () => tiktokApi.connections(),
	}),
};

/**
 * What an attempt status MEANS, from the module both sides share.
 *
 * The client must not decide any of this for itself. Which statuses are terminal
 * is what stops polling; which of them BLOCK a new publish is what stands between
 * one creator consent and two posts; and whether an attempt can be polled at all
 * decides whether the remedy is a status read or a human looking at TikTok. Each
 * is a safety judgement about an irreversible action, so all of them live beside
 * the codes they describe.
 */
export {
	type AttemptTone,
	attemptPhase,
	blocksNewPublish,
	canReadRemoteStatus,
	describeAttemptStatus,
	isTerminalAttemptStatus,
	type ManualResolution,
	pickAttemptToFollow,
	requiresManualResolution,
} from '$api/integrations/tiktok/attempt-status';
/**
 * The Direct Post rules, re-exported from the sibling Worker module that
 * ENFORCES them. The dashboard renders the same label explanations and the same
 * declaration sentence the server validates against, so the two cannot drift
 * into describing different agreements.
 */
export {
	COMMERCIAL_LABELS,
	DECLARATION_TEXT,
	declarationFor,
} from '$api/integrations/tiktok/direct-post-policy';
export type { PublishIntent } from '$api/integrations/tiktok/publish-intent';
/**
 * The idempotency-key lifecycle, from the module whose contract the server
 * validates. The dashboard must not mint keys per click; see publish-intent.ts.
 */
export {
	createPublishIntentKeeper,
	createSessionIntentKeyStore,
	isAmbiguousPublishFailure,
} from '$api/integrations/tiktok/publish-intent';
