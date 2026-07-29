/**
 * The TikTok Content Posting and Display API surface this integration uses.
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

/** `title` accepts 2,200 UTF-16 code units, which is what `String.length` counts. */
export const MAX_TITLE_LENGTH = 2_200;
/** TikTok caps one upload chunk at 64 MB; the canary uploads a single chunk. */
export const MAX_SINGLE_CHUNK_BYTES = 64 * 1024 * 1024;

export const privacyLevels = [
	'PUBLIC_TO_EVERYONE',
	'MUTUAL_FOLLOW_FRIENDS',
	'FOLLOWER_OF_CREATOR',
	'SELF_ONLY',
] as const;
export type TikTokPrivacyLevel = (typeof privacyLevels)[number];

export const postStatuses = [
	'PROCESSING_UPLOAD',
	'PROCESSING_DOWNLOAD',
	'SEND_TO_USER_INBOX',
	'PUBLISH_COMPLETE',
	'FAILED',
] as const;
export type TikTokPostStatusCode = (typeof postStatuses)[number];

export const TikTokApiError = defineErrors({
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
	}),
	/** TikTok's v2 envelope reported a failure. `code` is TikTok's own string. */
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
	}),
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
	}),
});
export type TikTokApiError = import('wellcrafted/error').InferErrors<
	typeof TikTokApiError
>;

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

export type TikTokVideo = {
	id: string;
	shareUrl: string;
	title: string;
	description: string;
	/** Unix epoch seconds, TikTok's own creation clock. */
	createTime: number;
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

function readEpochSeconds(value: unknown): number | null {
	const parsed =
		typeof value === 'number'
			? value
			: typeof value === 'string' && /^\d+$/.test(value)
				? Number(value)
				: Number.NaN;
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
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
		 * `user.info.basic`. Also names the account the token belongs to, so the
		 * connect callback needs no separate identity read.
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
		 * `video.upload`: send the video to the creator's TikTok inbox as a DRAFT.
		 *
		 * Nothing is published. The creator finishes and posts it inside the TikTok
		 * app, which is why this path carries no `post_info` at all: privacy and
		 * interaction settings are chosen there, not here.
		 */
		async initDraftUpload(
			videoSize: number,
		): Promise<
			Result<{ publishId: string; uploadUrl: string }, TikTokApiError>
		> {
			const endpoint = 'v2/post/publish/inbox/video/init';
			const { data, error } = await call(endpoint, {
				source_info: {
					source: 'FILE_UPLOAD',
					video_size: videoSize,
					chunk_size: videoSize,
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

		/** `video.list`: the creator's own recent posts. Proves the scope works. */
		async listVideos(
			maxCount = 10,
		): Promise<Result<TikTokVideo[], TikTokApiError>> {
			const endpoint = 'v2/video/list';
			const { data, error } = await call(
				endpoint,
				{ max_count: maxCount },
				{
					search: {
						fields: [
							'id',
							'share_url',
							'title',
							'video_description',
							'create_time',
						].join(','),
					},
				},
			);
			if (error) return { data: null, error };
			return Ok(readVideos(data));
		},

		/** `video.list`: read back exactly the posts a completed task named. */
		async queryVideos(
			videoIds: readonly string[],
		): Promise<Result<TikTokVideo[], TikTokApiError>> {
			const endpoint = 'v2/video/query';
			const { data, error } = await call(
				endpoint,
				{ filters: { video_ids: [...videoIds] } },
				{
					search: {
						fields: [
							'id',
							'share_url',
							'title',
							'video_description',
							'create_time',
						].join(','),
					},
				},
			);
			if (error) return { data: null, error };
			return Ok(readVideos(data));
		},
	};
}

/**
 * Both video endpoints answer with the same `videos` array. A row missing an id
 * or a create time is skipped rather than fatal: a partially readable list is
 * still useful verification, and TikTok occasionally returns sparse rows for
 * posts mid-processing.
 */
function readVideos(data: Record<string, unknown>): TikTokVideo[] {
	const rows = Array.isArray(data.videos) ? data.videos : [];
	const videos: TikTokVideo[] = [];
	for (const row of rows) {
		if (typeof row !== 'object' || row === null) continue;
		const fields = row as Record<string, unknown>;
		const id = readString(fields.id);
		const createTime = readEpochSeconds(fields.create_time);
		if (!id || createTime === null) continue;
		videos.push({
			id,
			shareUrl: readString(fields.share_url) ?? '',
			// Direct Post sends the caption as `title`; the Display API returns it as
			// `title` on some posts and `video_description` on others, so both are
			// carried rather than guessing which one TikTok chose.
			title: readString(fields.title) ?? '',
			description: readString(fields.video_description) ?? '',
			createTime,
		});
	}
	return videos;
}
