/**
 * The TikTok Content Posting API surface this integration uses.
 *
 * Exactly one publishing product: Direct Post. The inbox-draft path
 * (`video.upload`) and the Display API read-back (`video.list`) are deliberately
 * absent; see TIKTOK_SCOPES in config.ts for why each was removed rather than
 * left requested.
 *
 * Four properties of TikTok's v2 API shape everything here, and each one is a
 * correctness trap rather than a style preference:
 *
 * - **Two error channels.** Every `open.tiktokapis.com` v2 call answers with a
 *   real HTTP status AND an `error.code` string; success requires BOTH `2xx`
 *   and `code === 'ok'`. Checking only the status accepts failures as successes.
 * - **Creator options are read fresh, every time.** TikTok requires
 *   `creator_info/query` before any posting UI is shown, and its answer (which
 *   privacy levels this account may pick right now, which interactions it has
 *   switched off) is what the creator consents against. It is never cached.
 * - **Publishing is asynchronous and moderated.** `video/init` returns a
 *   `publish_id` naming a TASK. `publicaly_available_post_id` (TikTok's own
 *   misspelling) appears only once the post is public and has passed
 *   moderation, which is the only fact that proves a public delivery.
 * - **Post IDs exceed `Number.MAX_SAFE_INTEGER`.** They arrive as bare JSON
 *   numbers with 19 digits, so `JSON.parse` silently rounds them into IDs that
 *   name no post. See {@link preservePostIds}.
 *
 * Ported from the Vault's TikTok publisher, which established these behaviors
 * against the live API. The Vault holds no durable credential and stays a
 * separate, manually driven tool; this module is the hosted product path.
 */

import { defineErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

const OPEN_HOST = 'https://open.tiktokapis.com';

/**
 * Bounds on TikTok calls, so a stalled provider fails fast instead of holding a
 * Worker invocation (and any resource it borrowed) open indefinitely.
 *
 * The upload gets a far larger budget than the JSON endpoints because it pushes
 * up to one 64 MB chunk over a link Epicenter does not control, while every
 * other call is a small request/response.
 */
const API_REQUEST_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** `title` accepts 2,200 UTF-16 code units, which is what `String.length` counts. */
export const MAX_TITLE_LENGTH = 2_200;
/**
 * TikTok caps one upload chunk at 64 MB, and this integration uploads exactly
 * one chunk, so it is also the largest video a creator can post from here.
 */
export const MAX_SINGLE_CHUNK_BYTES = 64 * 1024 * 1024;

export const privacyLevels = [
	'PUBLIC_TO_EVERYONE',
	'MUTUAL_FOLLOW_FRIENDS',
	'FOLLOWER_OF_CREATOR',
	'SELF_ONLY',
] as const;
export type TikTokPrivacyLevel = (typeof privacyLevels)[number];

/**
 * Every status `status/fetch` can answer with, parsed as TikTok's own vocabulary
 * rather than re-coded into a local one.
 *
 * `SEND_TO_USER_INBOX` belongs to the inbox-draft product this integration no
 * longer offers, and is kept in the accepted set anyway: the job here is to
 * report what TikTok said, and turning an unexpected-but-real code into a
 * MalformedResponse would hide a real answer behind a parse failure.
 */
export const postStatuses = [
	'PROCESSING_UPLOAD',
	'PROCESSING_DOWNLOAD',
	'SEND_TO_USER_INBOX',
	'PUBLISH_COMPLETE',
	'FAILED',
] as const;
export type TikTokPostStatusCode = (typeof postStatuses)[number];

/**
 * Whether a failure tells us the request DEFINITELY did not take effect.
 *
 * This distinction only matters for one call, but it matters enormously there:
 * `video/init` is irreversible, so treating an ambiguous failure as a definite
 * one invites a retry that publishes a second post. Every variant therefore
 * declares which it is, rather than leaving callers to infer it from a message.
 *
 * - `rejected`: TikTok answered with its own `error.code` on a 4xx. The request
 *   was understood and refused, so nothing was created.
 * - `ambiguous`: we do not know. A timeout, a dropped connection, an
 *   unparseable body, a 5xx, or a success envelope missing the field that names
 *   what was created. TikTok may well have accepted the call.
 */
export type TikTokFailureCertainty = 'rejected' | 'ambiguous';

export const TikTokApiError = defineErrors({
	/**
	 * The call never produced a readable answer: transport failure, timeout, or a
	 * body we could not parse. ALWAYS ambiguous for a mutating call.
	 */
	RequestFailed: ({
		endpoint,
		reason,
	}: {
		endpoint: string;
		reason: string;
	}) => ({
		message: `TikTok ${endpoint} failed: ${reason}`,
		endpoint,
		reason,
		certainty: 'ambiguous' as TikTokFailureCertainty,
	}),
	/**
	 * TikTok's v2 envelope reported a failure. `code` is TikTok's own string.
	 *
	 * `certainty` is `rejected` only for a 4xx: a client error means the request
	 * was understood and refused. A 5xx is a server-side failure that may have
	 * landed anyway, so it stays ambiguous even though the envelope parsed.
	 */
	ProviderRejected: ({
		endpoint,
		code,
		detail,
		logId,
		status,
	}: {
		endpoint: string;
		code: string;
		detail: string;
		logId?: string;
		status: number;
	}) => ({
		message: `TikTok ${endpoint} rejected the request: ${detail} (${code})`,
		endpoint,
		code,
		detail,
		logId,
		status,
		certainty: (status >= 400 && status < 500
			? 'rejected'
			: 'ambiguous') as TikTokFailureCertainty,
	}),
	/**
	 * A success envelope that is missing a field the caller cannot proceed
	 * without. AMBIGUOUS by construction: TikTok said `ok`, so whatever the call
	 * does may already have happened, we just cannot name the result.
	 */
	MalformedResponse: ({
		endpoint,
		field,
	}: {
		endpoint: string;
		field: string;
	}) => ({
		message: `TikTok ${endpoint} response is missing ${field}.`,
		endpoint,
		field,
		certainty: 'ambiguous' as TikTokFailureCertainty,
	}),
});

export type TikTokApiError = import('wellcrafted/error').InferErrors<
	typeof TikTokApiError
>;

/**
 * True when a failure leaves the outcome UNKNOWN, so the caller must resolve it
 * by reading remote state rather than by retrying.
 */
export function isAmbiguousFailure(error: {
	certainty?: TikTokFailureCertainty;
}): boolean {
	// Default to ambiguous: an unclassified failure is not evidence of safety.
	return error.certainty !== 'rejected';
}

/** What this account may do RIGHT NOW, in TikTok's own words. */
export type TikTokCreatorInfo = {
	username: string;
	nickname: string;
	/** Only these may be offered; the set differs for private accounts. */
	privacyLevelOptions: TikTokPrivacyLevel[];
	/** `true` means the creator switched it off account-wide; one post cannot switch it back on. */
	commentDisabled: boolean;
	duetDisabled: boolean;
	stitchDisabled: boolean;
	maxVideoDurationSec: number;
};

export type TikTokUserInfo = {
	openId: string;
	unionId: string | null;
	displayName: string;
	username: string | null;
	avatarUrl: string | null;
};

export type TikTokPostStatus = {
	code: TikTokPostStatusCode;
	/** Non-empty only for a publicly viewable, moderation-approved post. */
	publicPostIds: string[];
	failReason?: string;
};

/** The creator's explicit, current choices. There is no default for any of them. */
export type DirectPostInput = {
	title: string;
	privacyLevel: TikTokPrivacyLevel;
	disableComment: boolean;
	disableDuet: boolean;
	disableStitch: boolean;
	/** "Your brand": the post promotes the creator's own business. */
	brandOrganic: boolean;
	/** "Branded content": a paid partnership. */
	brandedContent: boolean;
	/** TikTok's permanent AI-generated label. The author owns this claim. */
	isAigc: boolean;
	videoSize: number;
};

/**
 * TikTok returns `publicaly_available_post_id` as `list<int64>` rendered as bare
 * JSON numbers, and a real post ID has 19 digits, past `Number.MAX_SAFE_INTEGER`.
 * `JSON.parse` would silently round it, and the rounded ID would name a post that
 * does not exist, so a correct publication could never be verified.
 *
 * That array holds nothing but integers, so quoting them in the raw body before
 * parsing preserves each one exactly and cannot touch any other value. Every
 * other identifier TikTok sends here is already a string.
 */
export function preservePostIds(body: string): string {
	return body.replace(
		/("publicaly_available_post_id"\s*:\s*\[)([^\]]*)(])/,
		(_match, open: string, ids: string, close: string) =>
			`${open}${ids.replace(/-?\d+/g, '"$&"')}${close}`,
	);
}

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

export type TikTokApi = ReturnType<typeof createTikTokApi>;

export function createTikTokApi({
	accessToken,
	fetch: send = globalThis.fetch,
}: {
	accessToken: string;
	fetch?: typeof globalThis.fetch;
}) {
	/**
	 * Unwrap TikTok's v2 envelope. Success needs a 2xx AND `error.code === 'ok'`.
	 * The access token never appears in an error: failures name the endpoint
	 * path, never the request URL or headers.
	 */
	async function call(
		endpoint: string,
		body: unknown,
		{
			method = 'POST',
			search,
			transform,
		}: {
			method?: 'GET' | 'POST';
			search?: Record<string, string>;
			/** Applied to the raw body before parsing; see {@link preservePostIds}. */
			transform?: (raw: string) => string;
		} = {},
	): Promise<Result<Record<string, unknown>, TikTokApiError>> {
		const url = new URL(`${OPEN_HOST}/${endpoint}/`);
		for (const [key, value] of Object.entries(search ?? {})) {
			url.searchParams.set(key, value);
		}

		let response: Response;
		try {
			response = await send(url.toString(), {
				method,
				headers: {
					Authorization: `Bearer ${accessToken}`,
					...(method === 'POST'
						? { 'Content-Type': 'application/json; charset=UTF-8' }
						: {}),
				},
				...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
				signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
			});
		} catch (cause) {
			return TikTokApiError.RequestFailed({
				endpoint,
				reason: cause instanceof Error ? cause.message : 'network failure',
			});
		}

		const raw = await response.text().catch(() => '');
		let payload: unknown = null;
		try {
			payload = JSON.parse(transform ? transform(raw) : raw);
		} catch {
			return TikTokApiError.RequestFailed({
				endpoint,
				reason: `HTTP ${response.status} with an unparseable body`,
			});
		}
		if (typeof payload !== 'object' || payload === null) {
			return TikTokApiError.RequestFailed({
				endpoint,
				reason: `HTTP ${response.status} with a non-object body`,
			});
		}

		const envelope = payload as Record<string, unknown>;
		const errorField = envelope.error;
		const errorFields =
			typeof errorField === 'object' && errorField !== null
				? (errorField as Record<string, unknown>)
				: {};
		const code = readString(errorFields.code);
		if (!response.ok || code !== 'ok') {
			return TikTokApiError.ProviderRejected({
				endpoint,
				code: code ?? `http_${response.status}`,
				detail: readString(errorFields.message) ?? `HTTP ${response.status}`,
				...(readString(errorFields.log_id)
					? { logId: errorFields.log_id as string }
					: {}),
				status: response.status,
			});
		}

		const data = envelope.data;
		if (typeof data !== 'object' || data === null) {
			return TikTokApiError.MalformedResponse({ endpoint, field: 'data' });
		}
		return Ok(data as Record<string, unknown>);
	}

	return {
		/**
		 * `user.info.basic` plus `user.info.profile` for the exact username.
		 * Also names the account the token belongs to, so the connect callback
		 * needs no separate identity read.
		 */
		async readUserInfo(): Promise<Result<TikTokUserInfo, TikTokApiError>> {
			const endpoint = 'v2/user/info';
			const { data, error } = await call(endpoint, null, {
				method: 'GET',
				search: {
					fields: [
						'open_id',
						'union_id',
						'display_name',
						'username',
						'avatar_large_url',
					].join(','),
				},
			});
			if (error) return { data: null, error };
			const user = data.user;
			if (typeof user !== 'object' || user === null) {
				return TikTokApiError.MalformedResponse({ endpoint, field: 'user' });
			}
			const fields = user as Record<string, unknown>;
			const openId = readString(fields.open_id);
			if (!openId) {
				return TikTokApiError.MalformedResponse({ endpoint, field: 'open_id' });
			}
			return Ok({
				openId,
				unionId: readString(fields.union_id),
				// A creator can have an empty display name; the username, then the
				// open id, are the honest fallbacks. Never fabricate an email here.
				displayName:
					readString(fields.display_name) ??
					readString(fields.username) ??
					openId,
				username: readString(fields.username),
				avatarUrl: readString(fields.avatar_large_url),
			});
		},

		/**
		 * TikTok REQUIRES this read before any posting surface is shown, and the
		 * creator consents against exactly what it returns. Never cached.
		 */
		async readCreatorInfo(): Promise<
			Result<TikTokCreatorInfo, TikTokApiError>
		> {
			const endpoint = 'v2/post/publish/creator_info/query';
			const { data, error } = await call(endpoint, {});
			if (error) return { data: null, error };

			const offered = Array.isArray(data.privacy_level_options)
				? data.privacy_level_options
				: [];
			const levels: TikTokPrivacyLevel[] = [];
			for (const entry of offered) {
				// An unrecognized level is skipped rather than fatal: TikTok adding a
				// new one must not break connect, and the creator simply is not
				// offered a level this build cannot describe.
				if ((privacyLevels as readonly string[]).includes(entry as string)) {
					levels.push(entry as TikTokPrivacyLevel);
				}
			}
			if (levels.length === 0) {
				return TikTokApiError.MalformedResponse({
					endpoint,
					field: 'privacy_level_options',
				});
			}
			const nickname = readString(data.creator_nickname);
			if (!nickname) {
				return TikTokApiError.MalformedResponse({
					endpoint,
					field: 'creator_nickname',
				});
			}
			const flag = (key: string) =>
				typeof data[key] === 'boolean' ? (data[key] as boolean) : false;
			return Ok({
				username: readString(data.creator_username) ?? '',
				nickname,
				privacyLevelOptions: levels,
				commentDisabled: flag('comment_disabled'),
				duetDisabled: flag('duet_disabled'),
				stitchDisabled: flag('stitch_disabled'),
				maxVideoDurationSec:
					typeof data.max_video_post_duration_sec === 'number'
						? data.max_video_post_duration_sec
						: 0,
			});
		},

		/**
		 * `video.publish`: Direct Post. The irreversible call.
		 *
		 * The returned `publish_id` names a publishing TASK, so it does not yet
		 * prove a post exists. Callers must never retry this on an ambiguous
		 * outcome; resolve it by reading {@link readPostStatus} instead. The
		 * `tiktok_publish_attempt` row is claimed BEFORE this runs so a duplicate
		 * submit cannot reach it at all.
		 */
		async initDirectPost(
			input: DirectPostInput,
		): Promise<
			Result<{ publishId: string; uploadUrl: string }, TikTokApiError>
		> {
			const endpoint = 'v2/post/publish/video/init';
			const { data, error } = await call(endpoint, {
				post_info: {
					title: input.title,
					privacy_level: input.privacyLevel,
					disable_comment: input.disableComment,
					disable_duet: input.disableDuet,
					disable_stitch: input.disableStitch,
					brand_organic_toggle: input.brandOrganic,
					brand_content_toggle: input.brandedContent,
					is_aigc: input.isAigc,
				},
				source_info: {
					source: 'FILE_UPLOAD',
					video_size: input.videoSize,
					chunk_size: input.videoSize,
					total_chunk_count: 1,
				},
			});
			if (error) return { data: null, error };
			const publishId = readString(data.publish_id);
			const uploadUrl = readString(data.upload_url);
			if (!publishId) {
				return TikTokApiError.MalformedResponse({
					endpoint,
					field: 'publish_id',
				});
			}
			if (!uploadUrl) {
				return TikTokApiError.MalformedResponse({
					endpoint,
					field: 'upload_url',
				});
			}
			return Ok({ publishId, uploadUrl });
		},

		/**
		 * PUT the bytes to the pre-signed URL `init` returned.
		 *
		 * The access token is deliberately ABSENT: that URL carries its own
		 * authorization, and sending a bearer to a third-party-signed endpoint
		 * would leak the credential for no benefit.
		 */
		async uploadVideo(
			uploadUrl: string,
			video: Uint8Array<ArrayBuffer>,
		): Promise<Result<null, TikTokApiError>> {
			const endpoint = 'upload_url';
			const size = video.byteLength;
			let response: Response;
			try {
				response = await send(uploadUrl, {
					method: 'PUT',
					headers: {
						'Content-Type': 'video/mp4',
						'Content-Length': String(size),
						'Content-Range': `bytes 0-${size - 1}/${size}`,
					},
					body: video,
					signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
				});
			} catch (cause) {
				return TikTokApiError.RequestFailed({
					endpoint,
					reason: cause instanceof Error ? cause.message : 'network failure',
				});
			}
			if (!response.ok) {
				return TikTokApiError.RequestFailed({
					endpoint,
					reason: `TikTok rejected the uploaded video (HTTP ${response.status})`,
				});
			}
			return Ok(null);
		},

		/**
		 * Remote truth for one publishing task. A public post ID appears only after
		 * TikTok both publishes the post publicly AND approves it in moderation, so
		 * an empty list on a complete task is a wait or a private post, never proof
		 * of a public delivery.
		 */
		async readPostStatus(
			publishId: string,
		): Promise<Result<TikTokPostStatus, TikTokApiError>> {
			const endpoint = 'v2/post/publish/status/fetch';
			const { data, error } = await call(
				endpoint,
				{ publish_id: publishId },
				{ transform: preservePostIds },
			);
			if (error) return { data: null, error };
			const code = readString(data.status);
			if (!code || !(postStatuses as readonly string[]).includes(code)) {
				return TikTokApiError.MalformedResponse({ endpoint, field: 'status' });
			}
			// TikTok's field is misspelled in its own published schema.
			const ids = data.publicaly_available_post_id;
			const publicPostIds = Array.isArray(ids)
				? ids
						.map((id) => readString(id))
						.filter((id): id is string => id !== null)
				: [];
			const failReason = readString(data.fail_reason);
			return Ok({
				code: code as TikTokPostStatusCode,
				publicPostIds,
				...(failReason === null ? {} : { failReason }),
			});
		},
	};
}
