import { expect, test } from 'bun:test';
import {
	createTikTokApi,
	type DirectPostInput,
	isAmbiguousFailure,
	preservePostIds,
} from './api.js';

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

/**
 * A valid Direct Post body, for tests about the CALL rather than about the
 * choices. The failure-certainty tests below all exercise `initDirectPost`
 * because it is the irreversible call whose ambiguity actually matters.
 */
function directPostInput(): DirectPostInput {
	return {
		title: 't',
		privacyLevel: 'SELF_ONLY',
		disableComment: true,
		disableDuet: true,
		disableStitch: true,
		brandOrganic: false,
		brandedContent: false,
		isAigc: false,
		videoSize: 10,
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
			creator_username: 'braden',
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
			creator_username: 'braden',
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

// --- Failure certainty: the distinction that guards an irreversible call ---

test('a 4xx with TikTok error code is a DEFINITE rejection', async () => {
	const { api } = apiWith(() => envelope({}, 400, 'invalid_param'));

	const { error } = await api.initDirectPost(directPostInput());

	// Understood and refused: nothing was created, so a corrected retry is safe.
	expect(error?.certainty).toBe('rejected');
	expect(isAmbiguousFailure(error as never)).toBe(false);
});

test('a 5xx is AMBIGUOUS even though the envelope parsed', async () => {
	// A server-side failure may have landed anyway. Treating it as definite would
	// invite a retry that publishes twice.
	const { api } = apiWith(() => envelope({}, 503, 'internal_error'));

	const { error } = await api.initDirectPost(directPostInput());

	expect(error?.certainty).toBe('ambiguous');
	expect(isAmbiguousFailure(error as never)).toBe(true);
});

test('a network failure or timeout is AMBIGUOUS', async () => {
	const send = (async () => {
		throw new Error('The operation was aborted due to timeout');
	}) as unknown as typeof globalThis.fetch;
	const api = createTikTokApi({ accessToken: 'act.live', fetch: send });

	const { error } = await api.initDirectPost(directPostInput());

	expect(error?.name).toBe('RequestFailed');
	expect(isAmbiguousFailure(error as never)).toBe(true);
});

test('an unparseable body is AMBIGUOUS', async () => {
	const { api } = apiWith(
		() => new Response('<html>gateway</html>', { status: 200 }),
	);

	const { error } = await api.initDirectPost(directPostInput());

	expect(isAmbiguousFailure(error as never)).toBe(true);
});

test('an `ok` envelope missing publish_id is AMBIGUOUS, not a clean failure', async () => {
	// TikTok said ok, so the task may exist; we just cannot name it. This is the
	// case most easily mistaken for "nothing happened".
	const { api } = apiWith(() => envelope({ upload_url: 'https://upload/x' }));

	const { error } = await api.initDirectPost({
		title: 't',
		privacyLevel: 'SELF_ONLY',
		disableComment: true,
		disableDuet: true,
		disableStitch: true,
		brandOrganic: false,
		brandedContent: false,
		isAigc: false,
		videoSize: 10,
	});

	expect(error?.name).toBe('MalformedResponse');
	expect(isAmbiguousFailure(error as never)).toBe(true);
});

test('an unclassified failure defaults to ambiguous', () => {
	// Fail safe: absence of a certainty is not evidence that nothing happened.
	expect(isAmbiguousFailure({})).toBe(true);
});

// --- Only a PROVEN provider refusal is definite ---------------------------
//
// `video/init` is irreversible, so "definitely refused" must be earned. It is
// the one classification that permits a corrected retry, and getting it wrong on
// a request that actually landed publishes twice.

test('a 408 is AMBIGUOUS even though it is a 4xx', async () => {
	// A timeout is the textbook case where the request may well have been
	// processed. Classifying by status class alone called this definite.
	const { api } = apiWith(() => envelope({}, 408, 'request_timeout'));

	const { error } = await api.initDirectPost(directPostInput());

	expect(error?.certainty).toBe('ambiguous');
	expect(isAmbiguousFailure(error as never)).toBe(true);
});

test('a 4xx with NO TikTok error code is AMBIGUOUS, not a refusal', async () => {
	// A proxy, WAF, or load balancer can answer 400/403 without ever reaching
	// TikTok. Nothing in such a response proves TikTok refused anything, so it
	// cannot license a retry.
	const { api } = apiWith(
		() =>
			new Response(JSON.stringify({ message: 'Forbidden by edge' }), {
				status: 403,
				headers: { 'Content-Type': 'application/json' },
			}),
	);

	const { error } = await api.initDirectPost(directPostInput());

	expect(error?.certainty).toBe('ambiguous');
	expect(isAmbiguousFailure(error as never)).toBe(true);
});

test('a 4xx carrying a real TikTok error code IS a definite refusal', async () => {
	// TikTok understood the request and named why it refused, so no task exists.
	const { api } = apiWith(() => envelope({}, 400, 'invalid_param'));

	const { error } = await api.initDirectPost(directPostInput());

	expect(error?.certainty).toBe('rejected');
	expect(isAmbiguousFailure(error as never)).toBe(false);
});

test('a rate-limit refusal from TikTok is definite', async () => {
	const { api } = apiWith(() => envelope({}, 429, 'spam_risk_too_many_posts'));

	const { error } = await api.initDirectPost(directPostInput());

	expect(error?.certainty).toBe('rejected');
});

// --- creator_info fails closed on anything it cannot read ----------------

test('creator_info missing an interaction flag is MALFORMED, not "allowed"', async () => {
	// Defaulting a missing `comment_disabled` to false would tell the creator
	// comments are available and then publish an opt-in TikTok never authorized.
	const { api } = apiWith(() =>
		envelope({
			creator_username: 'braden',
			creator_nickname: 'Braden',
			privacy_level_options: ['PUBLIC_TO_EVERYONE'],
			duet_disabled: false,
			stitch_disabled: false,
			max_video_post_duration_sec: 600,
		}),
	);

	const { data, error } = await api.readCreatorInfo();

	expect(data).toBeNull();
	expect(error?.name).toBe('MalformedResponse');
	if (error?.name !== 'MalformedResponse')
		throw new Error('expected malformed');
	expect(error.field).toBe('comment_disabled');
});

test.each([
	'duet_disabled',
	'stitch_disabled',
])('creator_info missing %s is MALFORMED', async (missing) => {
	const flags: Record<string, boolean> = {
		comment_disabled: false,
		duet_disabled: false,
		stitch_disabled: false,
	};
	delete flags[missing];
	const { api } = apiWith(() =>
		envelope({
			creator_username: 'braden',
			creator_nickname: 'Braden',
			privacy_level_options: ['PUBLIC_TO_EVERYONE'],
			...flags,
			max_video_post_duration_sec: 600,
		}),
	);

	const { error } = await api.readCreatorInfo();

	expect(error?.name).toBe('MalformedResponse');
	if (error?.name !== 'MalformedResponse') {
		throw new Error('expected malformed');
	}
	expect(error.field).toBe(missing);
});

test('creator_info without a live username is MALFORMED', async () => {
	// The final confirmation names the account from THIS read. An empty username
	// there would have silently fallen back to a stored handle that may be stale.
	const { api } = apiWith(() =>
		envelope({
			creator_nickname: 'Braden',
			privacy_level_options: ['PUBLIC_TO_EVERYONE'],
			comment_disabled: false,
			duet_disabled: false,
			stitch_disabled: false,
			max_video_post_duration_sec: 600,
		}),
	);

	const { data, error } = await api.readCreatorInfo();

	expect(data).toBeNull();
	expect(error?.name).toBe('MalformedResponse');
	if (error?.name !== 'MalformedResponse')
		throw new Error('expected malformed');
	expect(error.field).toBe('creator_username');
});

test('a fully populated creator_info still reads cleanly', async () => {
	const { api } = apiWith(() =>
		envelope({
			creator_username: 'braden',
			creator_nickname: 'Braden',
			privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
			comment_disabled: false,
			duet_disabled: true,
			stitch_disabled: false,
			max_video_post_duration_sec: 600,
		}),
	);

	const { data, error } = await api.readCreatorInfo();

	expect(error).toBeNull();
	expect(data).toMatchObject({
		username: 'braden',
		nickname: 'Braden',
		duetDisabled: true,
		commentDisabled: false,
		maxVideoDurationSec: 600,
	});
});
