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
	TikTokVideo,
} from '$api/integrations/tiktok/api';
import type { PublicConnection } from '$api/integrations/tiktok/store';
import { auth } from '$lib/platform/auth';
import { defineQuery } from '$lib/query/client';

export type {
	PublicConnection,
	TikTokCreatorInfo,
	TikTokPrivacyLevel,
	TikTokVideo,
};

export type ConnectionsView = {
	/** False when the deployment has no TikTok credentials configured. */
	configured: boolean;
	/** The exact value to register in the TikTok developer portal. */
	redirectUri: string;
	requestedScopes: readonly string[];
	connections: PublicConnection[];
};

export type PublishAttempt = {
	id: string;
	connectionId: string;
	idempotencyKey: string;
	kind: string;
	publishId: string | null;
	status: string | null;
	failReason: string | null;
	createdAt: string;
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

	videos: (connectionId: string) =>
		send<{ videos: TikTokVideo[] }>(
			`${BASE}/connections/${connectionId}/videos`,
		),

	attempts: (connectionId: string) =>
		send<{ attempts: PublishAttempt[] }>(
			`${BASE}/connections/${connectionId}/attempts`,
		),

	publishStatus: (connectionId: string, publishId: string) =>
		send<TikTokPostStatus>(
			`${BASE}/connections/${connectionId}/publish/${publishId}`,
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
			kind: string;
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
export { createPublishIntentKeeper } from '$api/integrations/tiktok/publish-intent';
