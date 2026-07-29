import { expect, test } from 'bun:test';
import { createTikTokApi, preservePostIds } from './api.js';

type Call = {
	url: string;
	method: string;
	headers: Headers;
	body: string | null;
};

function recordingFetch(respond: (call: Call) => Response) {
	const calls: Call[] = [];
	const send = (async (input: string | URL, init?: RequestInit) => {
		const call: Call = {
			url: String(input),
			method: init?.method ?? 'GET',
			headers: new Headers(init?.headers),
			body: typeof init?.body === 'string' ? init.body : null,
		};
		calls.push(call);
		return respond(call);
	}) as unknown as typeof globalThis.fetch;
	return { send, calls };
}

/** TikTok's v2 envelope: success requires 2xx AND `error.code === 'ok'`. */
function envelope(data: unknown, status = 200, code = 'ok'): Response {
	return new Response(
		JSON.stringify({ data, error: { code, message: '', log_id: 'log-1' } }),
		{ status, headers: { 'Content-Type': 'application/json' } },
	);
}

function apiWith(respond: (call: Call) => Response) {
	const { send, calls } = recordingFetch(respond);
	return {
		api: createTikTokApi({ accessToken: 'act.live', fetch: send }),
		calls,
	};
}

test('a 2xx response whose envelope reports a non-ok code is a failure', async () => {
	const { api } = apiWith(
		() =>
			new Response(
				JSON.stringify({
					data: {},
					error: {
						code: 'spam_risk_too_many_posts',
						message: 'Daily post cap reached',
						log_id: 'log-9',
					},
				}),
				{ status: 200 },
			),
	);

	const { data, error } = await api.readCreatorInfo();

	// Checking only the HTTP status would have accepted this as success.
	expect(data).toBeNull();
	expect(error?.name).toBe('ProviderRejected');
	expect(error).toMatchObject({
		code: 'spam_risk_too_many_posts',
		logId: 'log-9',
	});
	expect(error?.message).toContain('Daily post cap reached');
});

test('preservePostIds keeps 19-digit post IDs exact through JSON.parse', () => {
	// A real TikTok post ID exceeds Number.MAX_SAFE_INTEGER (9007199254740991).
	const raw =
		'{"publicaly_available_post_id":[7382910473829104721],"status":"PUBLISH_COMPLETE"}';

	const roundedNaively = JSON.parse(raw) as {
		publicaly_available_post_id: number[];
	};
	const preserved = JSON.parse(preservePostIds(raw)) as {
		publicaly_available_post_id: string[];
	};

	// Proof the trap is real: the naive parse silently corrupts the ID.
	expect(String(roundedNaively.publicaly_available_post_id[0])).not.toBe(
		'7382910473829104721',
	);
	expect(preserved.publicaly_available_post_id[0]).toBe('7382910473829104721');
});

test('preservePostIds leaves every other value untouched', () => {
	const raw =
		'{"status":"PUBLISH_COMPLETE","count":42,"publicaly_available_post_id":[1,2]}';

	const parsed = JSON.parse(preservePostIds(raw)) as Record<string, unknown>;

	expect(parsed.status).toBe('PUBLISH_COMPLETE');
	expect(parsed.count).toBe(42);
	expect(parsed.publicaly_available_post_id).toEqual(['1', '2']);
});

test('readPostStatus returns exact post IDs as strings', async () => {
	const { api } = apiWith(
		() =>
			new Response(
				'{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7382910473829104721]},"error":{"code":"ok"}}',
				{ status: 200 },
			),
	);

	const { data } = await api.readPostStatus('publish-1');

	expect(data?.code).toBe('PUBLISH_COMPLETE');
	expect(data?.publicPostIds).toEqual(['7382910473829104721']);
});

test('a complete task with no public post ID is NOT reported as a public delivery', async () => {
	const { api } = apiWith(() =>
		envelope({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [] }),
	);

	const { data } = await api.readPostStatus('publish-1');

	// Empty means private, or still awaiting moderation. Never "published publicly".
	expect(data?.publicPostIds).toEqual([]);
});

test("a FAILED status carries TikTok's own fail reason", async () => {
	const { api } = apiWith(() =>
		envelope({ status: 'FAILED', fail_reason: 'video_format_unsupported' }),
	);

	const { data } = await api.readPostStatus('publish-1');

	expect(data?.code).toBe('FAILED');
	expect(data?.failReason).toBe('video_format_unsupported');
});

test('readCreatorInfo surfaces the account ceilings the creator consents against', async () => {
	const { api, calls } = apiWith(() =>
		envelope({
			creator_username: 'braden',
			creator_nickname: 'Braden',
			privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'],
			comment_disabled: true,
			duet_disabled: false,
			stitch_disabled: true,
			max_video_post_duration_sec: 600,
		}),
	);

	const { data } = await api.readCreatorInfo();

	expect(data).toMatchObject({
		username: 'braden',
		nickname: 'Braden',
		privacyLevelOptions: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'],
		commentDisabled: true,
		duetDisabled: false,
		stitchDisabled: true,
		maxVideoDurationSec: 600,
	});
	expect(calls[0]?.url).toContain('/v2/post/publish/creator_info/query/');
	expect(calls[0]?.headers.get('Authorization')).toBe('Bearer act.live');
});

test('an unrecognized privacy level is skipped, not fatal', async () => {
	const { api } = apiWith(() =>
		envelope({
			creator_nickname: 'Braden',
			privacy_level_options: ['SELF_ONLY', 'SOME_FUTURE_LEVEL'],
			comment_disabled: false,
			duet_disabled: false,
			stitch_disabled: false,
			max_video_post_duration_sec: 60,
		}),
	);

	const { data, error } = await api.readCreatorInfo();

	expect(error).toBeNull();
	expect(data?.privacyLevelOptions).toEqual(['SELF_ONLY']);
});

test('creator info offering no usable privacy level is a malformed response', async () => {
	const { api } = apiWith(() =>
		envelope({
			creator_nickname: 'Braden',
			privacy_level_options: [],
			comment_disabled: false,
			duet_disabled: false,
			stitch_disabled: false,
			max_video_post_duration_sec: 60,
		}),
	);

	const { data, error } = await api.readCreatorInfo();

	expect(data).toBeNull();
	expect(error?.name).toBe('MalformedResponse');
});

test('initDirectPost sends the creator declarations TikTok requires', async () => {
	const { api, calls } = apiWith(() =>
		envelope({
			publish_id: 'pub-1',
			upload_url: 'https://upload.tiktok/presigned',
		}),
	);

	const { data } = await api.initDirectPost({
		title: 'A caption',
		privacyLevel: 'SELF_ONLY',
		disableComment: true,
		disableDuet: false,
		disableStitch: true,
		brandOrganic: true,
		brandedContent: false,
		isAigc: true,
		videoSize: 1024,
	});

	expect(data).toEqual({
		publishId: 'pub-1',
		uploadUrl: 'https://upload.tiktok/presigned',
	});
	const sent = JSON.parse(calls[0]?.body ?? '{}');
	expect(calls[0]?.url).toContain('/v2/post/publish/video/init/');
	expect(sent.post_info).toEqual({
		title: 'A caption',
		privacy_level: 'SELF_ONLY',
		disable_comment: true,
		disable_duet: false,
		disable_stitch: true,
		brand_organic_toggle: true,
		brand_content_toggle: false,
		is_aigc: true,
	});
	expect(sent.source_info).toEqual({
		source: 'FILE_UPLOAD',
		video_size: 1024,
		chunk_size: 1024,
		total_chunk_count: 1,
	});
});

test('initDraftUpload targets the inbox endpoint and sends NO post_info', async () => {
	const { api, calls } = apiWith(() =>
		envelope({
			publish_id: 'pub-2',
			upload_url: 'https://upload.tiktok/presigned',
		}),
	);

	const { data } = await api.initDraftUpload(2048);

	expect(data?.publishId).toBe('pub-2');
	expect(calls[0]?.url).toContain('/v2/post/publish/inbox/video/init/');
	// Privacy and interaction settings are chosen by the creator in the TikTok
	// app for a draft, so sending them here would be a lie about what was agreed.
	expect(JSON.parse(calls[0]?.body ?? '{}').post_info).toBeUndefined();
});

test('uploadVideo PUTs the bytes WITHOUT the access token', async () => {
	const { api, calls } = apiWith(() => new Response(null, { status: 201 }));
	const bytes = new Uint8Array(new ArrayBuffer(10)).fill(7);

	const { error } = await api.uploadVideo(
		'https://upload.tiktok/presigned',
		bytes,
	);

	expect(error).toBeNull();
	expect(calls[0]?.method).toBe('PUT');
	// The presigned URL carries its own authorization; sending a bearer there
	// would leak the credential to a third-party-signed endpoint for no benefit.
	expect(calls[0]?.headers.get('Authorization')).toBeNull();
	expect(calls[0]?.headers.get('Content-Range')).toBe('bytes 0-9/10');
});

test('a rejected upload is a named failure', async () => {
	const { api } = apiWith(() => new Response(null, { status: 413 }));

	const { error } = await api.uploadVideo(
		'https://upload.tiktok/presigned',
		new Uint8Array(new ArrayBuffer(4)),
	);

	expect(error?.name).toBe('RequestFailed');
	expect(error?.message).toContain('413');
});

test('listVideos reads both title spellings TikTok uses', async () => {
	const { api, calls } = apiWith(() =>
		envelope({
			videos: [
				{
					id: '111',
					share_url: 'https://tiktok.com/@x/video/111',
					title: 'From title',
					create_time: 1_700_000_000,
				},
				{
					id: '222',
					share_url: 'https://tiktok.com/@x/video/222',
					video_description: 'From description',
					create_time: '1700000001',
				},
			],
		}),
	);

	const { data } = await api.listVideos();

	expect(calls[0]?.url).toContain('/v2/video/list/');
	expect(data).toHaveLength(2);
	expect(data?.[0]).toMatchObject({ id: '111', title: 'From title' });
	// `create_time` arrives as a number on some rows and a string on others.
	expect(data?.[1]).toMatchObject({
		id: '222',
		description: 'From description',
		createTime: 1_700_000_001,
	});
});

test('a video row missing an id is skipped rather than poisoning the list', async () => {
	const { api } = apiWith(() =>
		envelope({
			videos: [
				{ share_url: 'https://x', create_time: 1 },
				{ id: '333', share_url: 'https://y', create_time: 2 },
			],
		}),
	);

	const { data } = await api.listVideos();

	expect(data).toHaveLength(1);
	expect(data?.[0]?.id).toBe('333');
});

test('readUserInfo never fabricates an email and falls back honestly for a blank name', async () => {
	const { api } = apiWith(() =>
		envelope({
			user: { open_id: 'open-1', username: 'braden', display_name: '' },
		}),
	);

	const { data } = await api.readUserInfo();

	// Better Auth's TikTok provider maps `email: user.email || user.username`,
	// which would put a username into a unique email column. Nothing here does.
	expect(JSON.stringify(data)).not.toContain('email');
	expect(data).toMatchObject({
		openId: 'open-1',
		username: 'braden',
		displayName: 'braden',
	});
});

test('an HTTP error with an unparseable body is a request failure, not a crash', async () => {
	const { api } = apiWith(
		() => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
	);

	const { data, error } = await api.readCreatorInfo();

	expect(data).toBeNull();
	expect(error?.name).toBe('RequestFailed');
});

test('no API error message leaks the access token', async () => {
	const { api } = apiWith(() => envelope({}, 401, 'access_token_invalid'));

	const { error } = await api.readCreatorInfo();

	expect(error?.name).toBe('ProviderRejected');
	expect(JSON.stringify(error)).not.toContain('act.live');
});
