import { expect, test } from 'bun:test';
import type { CloudEnv } from '@epicenter/server';
import { Hono } from 'hono';
import { mountTikTokIntegrationApi } from './routes.js';

const ORIGIN = 'https://api.epicenter.so';
const KEY = Buffer.from(new Uint8Array(32).fill(3)).toString('base64url');

const CONFIGURED_ENV = {
	TIKTOK_CLIENT_KEY: 'client-key-123',
	TIKTOK_CLIENT_SECRET: 'client-secret-DO-NOT-LEAK',
	TIKTOK_TOKEN_ENCRYPTION_KEY: KEY,
};

type FakeSession = {
	user: { id: string; email: string };
	session: { createdAt: Date };
};

/** A session created now: fresh by Better Auth's 24h `freshAge`. */
function freshSession(userId = 'user-1'): FakeSession {
	return {
		user: { id: userId, email: 'braden@example.com' },
		session: { createdAt: new Date() },
	};
}

/** A session older than `freshAge`: valid, but not fresh. */
function staleSession(userId = 'user-1'): FakeSession {
	return {
		user: { id: userId, email: 'braden@example.com' },
		session: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
	};
}

type DbScript = {
	/** Rows returned by `select(...).from(...)...`. */
	selectRows?: unknown[];
	/** Row returned by `delete(...).returning()` (state consumption). */
	deleteReturning?: unknown[];
	insertRows?: unknown[];
};

/**
 * A db stand-in that records the writes it was asked to make. `touched` proves
 * whether a route reached Postgres at all, which is how the auth tests below
 * show a 401 is decided BEFORE any query runs.
 */
function fakeDb(script: DbScript = {}) {
	const inserted: unknown[] = [];
	const state = { touched: false };
	/**
	 * Drizzle builders are awaitable at several different points in a chain
	 * (`db.insert(t).values(row)` and `db.delete(t).where(w).returning()` are both
	 * valid terminals), so each link is a REAL promise carrying the builder
	 * methods. Building on an actual Promise rather than an object with a `then`
	 * key keeps this a genuine thenable instead of a look-alike.
	 */
	// Returns `unknown` because the shape is self-referential; the handle is cast
	// at its injection point anyway.
	const chainOf = (rows: unknown[]): unknown => {
		const chain = Object.assign(Promise.resolve(rows), {
			from: () => chainOf(rows),
			where: () => chainOf(rows),
			orderBy: () => chainOf(rows),
			limit: () => chainOf(rows),
			returning: () => chainOf(rows),
			for: () => chainOf(rows),
			set: () => chainOf(rows),
			values: (value: unknown) => {
				inserted.push(value);
				return chainOf(rows);
			},
			onConflictDoUpdate: () => chainOf(rows),
			onConflictDoNothing: () => chainOf(rows),
		});
		return chain;
	};
	const thenableRows = chainOf;
	const db = {
		select: () => {
			state.touched = true;
			return thenableRows(script.selectRows ?? []);
		},
		insert: () => {
			state.touched = true;
			return thenableRows(script.insertRows ?? []);
		},
		delete: () => {
			state.touched = true;
			return thenableRows(script.deleteReturning ?? []);
		},
		update: () => {
			state.touched = true;
			return thenableRows([]);
		},
		/**
		 * `ensureAccessToken` locks the row inside a transaction. The tx sees no
		 * rows here, so token custody reports `ConnectionNotFound` and the route
		 * answers 502. That is deliberate: these route tests exercise the gates
		 * BEFORE token custody, and tokens.test.ts owns the custody behavior
		 * against a fake that models the row lock.
		 */
		transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
			state.touched = true;
			return fn({ select: () => thenableRows([]) });
		},
	};
	return { db, inserted, state };
}

function createTikTokTestApp({
	session = null,
	env = {},
	db = fakeDb().db,
}: {
	session?: FakeSession | null;
	env?: Record<string, string>;
	db?: unknown;
} = {}) {
	const app = new Hono<CloudEnv>();
	app.use('*', async (c, next) => {
		c.set('authBaseURL', ORIGIN);
		c.set('db', db as never);
		c.set('auth', {
			api: { getSession: async () => session },
		} as never);
		await next();
	});
	// Hono reads bindings from the fetch `env` argument; supplying it per request
	// below keeps this helper's shape simple.
	mountTikTokIntegrationApi(app);
	return { app, env };
}

function request(
	built: ReturnType<typeof createTikTokTestApp>,
	path: string,
	init?: RequestInit,
) {
	return built.app.request(path, init, built.env);
}

// --- Authentication boundaries -------------------------------------------

test('every TikTok route refuses an unauthenticated request with 401', async () => {
	const { db, state } = fakeDb();
	const built = createTikTokTestApp({ session: null, env: CONFIGURED_ENV, db });

	const calls: [string, RequestInit | undefined][] = [
		['/api/integrations/tiktok/connect', { method: 'POST' }],
		['/api/integrations/tiktok/connections', undefined],
		['/api/integrations/tiktok/connections/conn-1', { method: 'DELETE' }],
		['/api/integrations/tiktok/connections/conn-1/creator-info', undefined],
		['/api/integrations/tiktok/connections/conn-1/videos', undefined],
		['/api/integrations/tiktok/connections/conn-1/attempts', undefined],
		['/api/integrations/tiktok/connections/conn-1/publish', { method: 'POST' }],
	];

	for (const [path, init] of calls) {
		const res = await request(built, path, init);
		expect(res.status).toBe(401);
	}
	// The refusal is decided before any query runs.
	expect(state.touched).toBe(false);
});

test('connect and disconnect additionally demand a FRESH session', async () => {
	const built = createTikTokTestApp({
		session: staleSession(),
		env: CONFIGURED_ENV,
	});

	for (const [path, init] of [
		['/api/integrations/tiktok/connect', { method: 'POST' }],
		['/api/integrations/tiktok/connections/conn-1', { method: 'DELETE' }],
	] as const) {
		const res = await request(built, path, init);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { code: string } };
		// The dashboard already knows this remedy from link-social and deletion.
		expect(body.error.code).toBe('SESSION_NOT_FRESH');
	}
});

test('reading connections accepts a valid but non-fresh session', async () => {
	const { db } = fakeDb({ selectRows: [] });
	const built = createTikTokTestApp({
		session: staleSession(),
		env: CONFIGURED_ENV,
		db,
	});

	const res = await request(built, '/api/integrations/tiktok/connections');

	// Listing what is connected is not a change to what is authorized.
	expect(res.status).toBe(200);
});

// --- Unconfigured deployment ---------------------------------------------

test('an unconfigured deployment answers a named 503 naming every missing binding', async () => {
	const built = createTikTokTestApp({ session: freshSession(), env: {} });

	const res = await request(built, '/api/integrations/tiktok/connect', {
		method: 'POST',
	});

	expect(res.status).toBe(503);
	const body = (await res.json()) as {
		error: { name: string; missing: string[] };
	};
	expect(body.error.name).toBe('NotConfigured');
	expect(body.error.missing).toEqual([
		'TIKTOK_CLIENT_KEY',
		'TIKTOK_CLIENT_SECRET',
		'TIKTOK_TOKEN_ENCRYPTION_KEY',
	]);
});

test('the connections list reports configured=false instead of pretending to work', async () => {
	const { db } = fakeDb({ selectRows: [] });
	const built = createTikTokTestApp({ session: freshSession(), env: {}, db });

	const res = await request(built, '/api/integrations/tiktok/connections');
	const body = (await res.json()) as {
		configured: boolean;
		redirectUri: string;
	};

	expect(res.status).toBe(200);
	expect(body.configured).toBe(false);
	// The exact portal value stays readable even while unconfigured.
	expect(body.redirectUri).toBe(
		'https://api.epicenter.so/api/integrations/tiktok/callback',
	);
});

// --- Connect --------------------------------------------------------------

test('connect returns a TikTok consent URL and binds a single-use state to this user', async () => {
	const { db, inserted } = fakeDb();
	const built = createTikTokTestApp({
		session: freshSession('user-42'),
		env: CONFIGURED_ENV,
		db,
	});

	const res = await request(built, '/api/integrations/tiktok/connect', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ returnPath: '/dashboard/integrations' }),
	});

	expect(res.status).toBe(200);
	const { url } = (await res.json()) as { url: string };
	const authorize = new URL(url);
	expect(authorize.origin + authorize.pathname).toBe(
		'https://www.tiktok.com/v2/auth/authorize/',
	);
	expect(authorize.searchParams.get('client_key')).toBe('client-key-123');
	expect(authorize.searchParams.get('scope')).toBe(
		'user.info.basic,video.list,video.upload,video.publish',
	);
	expect(authorize.searchParams.get('redirect_uri')).toBe(
		'https://api.epicenter.so/api/integrations/tiktok/callback',
	);

	// The state row is bound to the initiating Epicenter user and expires. With
	// no PKCE in the web flow, this binding plus single-use consumption IS the
	// CSRF defense, so it is asserted directly.
	const state = inserted[0] as {
		state: string;
		userId: string;
		expiresAt: Date;
	};
	expect(state.userId).toBe('user-42');
	expect(state.state).toBe(authorize.searchParams.get('state') ?? '');
	expect(state.expiresAt.getTime()).toBeGreaterThan(Date.now());
	// No PKCE parameters reach TikTok's web authorize endpoint.
	expect(authorize.searchParams.get('code_challenge')).toBeNull();
	expect(authorize.searchParams.get('code_challenge_method')).toBeNull();
});

test('the client secret never reaches the browser', async () => {
	const { db } = fakeDb();
	const built = createTikTokTestApp({
		session: freshSession(),
		env: CONFIGURED_ENV,
		db,
	});

	const res = await request(built, '/api/integrations/tiktok/connect', {
		method: 'POST',
	});

	expect(await res.text()).not.toContain('client-secret-DO-NOT-LEAK');
});

test('connect refuses to bounce the browser to an off-site returnPath', async () => {
	const { db, inserted } = fakeDb();
	const built = createTikTokTestApp({
		session: freshSession(),
		env: CONFIGURED_ENV,
		db,
	});

	await request(built, '/api/integrations/tiktok/connect', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ returnPath: '//evil.example/steal' }),
	});

	// A protocol-relative URL would leave the origin; it falls back to the
	// dashboard rather than being stored as an open redirect.
	expect((inserted[0] as { returnPath: string }).returnPath).toBe(
		'/dashboard/integrations',
	);
});

// --- Callback -------------------------------------------------------------

test('a callback with an unknown or replayed state connects nothing', async () => {
	// `DELETE ... RETURNING` finds no row: already used, expired, or forged.
	const { db } = fakeDb({ deleteReturning: [] });
	const built = createTikTokTestApp({
		session: freshSession(),
		env: CONFIGURED_ENV,
		db,
	});

	const res = await request(
		built,
		'/api/integrations/tiktok/callback?code=abc&state=replayed',
	);

	expect(res.status).toBe(302);
	const location = new URL(res.headers.get('Location') ?? '', ORIGIN);
	expect(location.pathname).toBe('/dashboard/integrations');
	expect(location.searchParams.get('error') ?? '').toContain('already used');
	expect(location.searchParams.get('connected')).toBeNull();
});

test('a state minted by another Epicenter user cannot attach an account to this one', async () => {
	const { db } = fakeDb({
		deleteReturning: [
			{
				state: 's',
				userId: 'user-who-started-it',
				returnPath: '/dashboard/integrations',
				expiresAt: new Date(Date.now() + 60_000),
			},
		],
	});
	const built = createTikTokTestApp({
		// A different signed-in user arrives at the callback.
		session: freshSession('a-different-user'),
		env: CONFIGURED_ENV,
		db,
	});

	const res = await request(
		built,
		'/api/integrations/tiktok/callback?code=abc&state=s',
	);

	expect(res.status).toBe(302);
	const location = new URL(res.headers.get('Location') ?? '', ORIGIN);
	expect(location.searchParams.get('error') ?? '').toContain(
		'different Epicenter account',
	);
	expect(location.searchParams.get('connected')).toBeNull();
});

test('an expired state is refused even though it was consumed', async () => {
	const { db } = fakeDb({
		deleteReturning: [
			{
				state: 's',
				userId: 'user-1',
				returnPath: '/dashboard/integrations',
				expiresAt: new Date(Date.now() - 1_000),
			},
		],
	});
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});

	const res = await request(
		built,
		'/api/integrations/tiktok/callback?code=abc&state=s',
	);

	const location = new URL(res.headers.get('Location') ?? '', ORIGIN);
	expect(location.searchParams.get('error') ?? '').toContain('took too long');
});

test('a declined consent returns a readable message and connects nothing', async () => {
	const { db } = fakeDb({ deleteReturning: [] });
	const built = createTikTokTestApp({
		session: freshSession(),
		env: CONFIGURED_ENV,
		db,
	});

	const res = await request(
		built,
		'/api/integrations/tiktok/callback?error=access_denied&error_description=The+user+denied+the+request&state=s',
	);

	expect(res.status).toBe(302);
	const location = new URL(res.headers.get('Location') ?? '', ORIGIN);
	expect(location.searchParams.get('error') ?? '').toBe(
		'The user denied the request',
	);
	expect(location.searchParams.get('connected')).toBeNull();
});

// --- Responses never carry tokens ----------------------------------------

test('the connections response carries identity and scopes but no token material', async () => {
	const { db } = fakeDb({
		selectRows: [
			{
				id: 'conn-1',
				userId: 'user-1',
				openId: 'open-abc',
				unionId: null,
				displayName: 'Braden',
				username: 'braden',
				avatarUrl: null,
				scopes: ['user.info.basic', 'video.publish'],
				accessTokenCiphertext: 'v1.IV-SECRET.CIPHERTEXT-SECRET',
				accessTokenExpiresAt: new Date('2026-08-01T00:00:00Z'),
				refreshTokenCiphertext: 'v1.IV-REFRESH.CIPHERTEXT-REFRESH',
				refreshTokenExpiresAt: new Date('2027-07-01T00:00:00Z'),
				createdAt: new Date('2026-07-01T00:00:00Z'),
				updatedAt: new Date('2026-07-01T00:00:00Z'),
			},
		],
	});
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});

	const res = await request(built, '/api/integrations/tiktok/connections');
	const raw = await res.text();

	expect(res.status).toBe(200);
	// Not even the ciphertext leaves the server.
	expect(raw).not.toContain('CIPHERTEXT-SECRET');
	expect(raw).not.toContain('CIPHERTEXT-REFRESH');
	expect(raw).not.toContain('Ciphertext');
	const body = JSON.parse(raw) as {
		connections: { openId: string; scopes: string[]; displayName: string }[];
	};
	// The exact identity and the scopes actually granted ARE shown, so a creator
	// with many accounts can tell which one they are about to post as.
	expect(body.connections[0]).toMatchObject({
		openId: 'open-abc',
		displayName: 'Braden',
		scopes: ['user.info.basic', 'video.publish'],
	});
});

// --- Scope gating ---------------------------------------------------------

/** A stored connection granting exactly the scopes given. */
function connectionRow(scopes: string[]) {
	return {
		id: 'conn-1',
		userId: 'user-1',
		openId: 'open-abc',
		unionId: null,
		displayName: 'Braden',
		username: 'braden',
		avatarUrl: null,
		scopes,
		accessTokenCiphertext: 'v1.a.b',
		accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
		refreshTokenCiphertext: 'v1.a.b',
		refreshTokenExpiresAt: new Date(Date.now() + 3_600_000),
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

test('creator info and publish status accept EITHER publishing scope', async () => {
	// `creator_info/query` and `status/fetch` serve both the draft and the Direct
	// Post flows, so demanding one specific scope would lock out a creator who
	// granted only the other. Either scope reaches token custody (502 against
	// this fake) instead of being refused at the gate with 403.
	for (const grantedScope of ['video.upload', 'video.publish']) {
		const { db } = fakeDb({ selectRows: [connectionRow([grantedScope])] });
		const built = createTikTokTestApp({
			session: freshSession('user-1'),
			env: CONFIGURED_ENV,
			db,
		});

		for (const path of [
			'/api/integrations/tiktok/connections/conn-1/creator-info',
			'/api/integrations/tiktok/connections/conn-1/publish/pub-1',
		]) {
			const res = await request(built, path);
			expect(res.status).not.toBe(403);
			expect(res.status).toBe(502);
		}
	}
});

test('a connection granting neither publishing scope is still refused', async () => {
	const { db } = fakeDb({ selectRows: [connectionRow(['user.info.basic'])] });
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});

	const res = await request(
		built,
		'/api/integrations/tiktok/connections/conn-1/creator-info',
	);

	expect(res.status).toBe(403);
	const body = (await res.json()) as { error: { name: string; scope: string } };
	expect(body.error.name).toBe('ScopeNotGranted');
	// Both acceptable scopes are named, so the remedy is actionable.
	expect(body.error.scope).toBe('video.publish or video.upload');
});

// --- Publish guards -------------------------------------------------------

test('publish refuses a request with no idempotency key before touching TikTok', async () => {
	const { db } = fakeDb();
	const built = createTikTokTestApp({
		session: freshSession(),
		env: CONFIGURED_ENV,
		db,
	});
	const form = new FormData();
	form.set('kind', 'direct_post');
	form.set(
		'video',
		new File([new Uint8Array(10)], 'v.mp4', { type: 'video/mp4' }),
	);

	const res = await request(
		built,
		'/api/integrations/tiktok/connections/c1/publish',
		{
			method: 'POST',
			body: form,
		},
	);

	expect(res.status).toBe(400);
	const body = (await res.json()) as { error: { message: string } };
	expect(body.error.message).toContain('idempotencyKey');
});

test('publish refuses a request with no video file', async () => {
	const { db } = fakeDb();
	const built = createTikTokTestApp({
		session: freshSession(),
		env: CONFIGURED_ENV,
		db,
	});
	const form = new FormData();
	form.set('kind', 'draft_upload');
	form.set('idempotencyKey', 'key-1');

	const res = await request(
		built,
		'/api/integrations/tiktok/connections/c1/publish',
		{
			method: 'POST',
			body: form,
		},
	);

	expect(res.status).toBe(400);
	const body = (await res.json()) as { error: { message: string } };
	expect(body.error.message).toContain('video file');
});

test('publish refuses a connection whose grant lacks the scope the request needs', async () => {
	const { db } = fakeDb({
		selectRows: [
			{
				id: 'conn-1',
				userId: 'user-1',
				openId: 'open-abc',
				unionId: null,
				displayName: 'Braden',
				username: 'braden',
				avatarUrl: null,
				// The creator declined video.publish at the consent screen.
				scopes: ['user.info.basic', 'video.upload'],
				accessTokenCiphertext: 'v1.a.b',
				accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
				refreshTokenCiphertext: 'v1.a.b',
				refreshTokenExpiresAt: new Date(Date.now() + 3_600_000),
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		],
	});
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});
	const form = new FormData();
	form.set('kind', 'direct_post');
	form.set('idempotencyKey', 'key-1');
	form.set(
		'video',
		new File([new Uint8Array(10)], 'v.mp4', { type: 'video/mp4' }),
	);

	const res = await request(
		built,
		'/api/integrations/tiktok/connections/conn-1/publish',
		{ method: 'POST', body: form },
	);

	expect(res.status).toBe(403);
	const body = (await res.json()) as { error: { name: string; scope: string } };
	expect(body.error.name).toBe('ScopeNotGranted');
	expect(body.error.scope).toBe('video.publish');
});

test('a connection belonging to another user reads as not found', async () => {
	// The owner-scoped query returns nothing for a guessed id.
	const { db } = fakeDb({ selectRows: [] });
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});

	const res = await request(
		built,
		'/api/integrations/tiktok/connections/someone-elses-id/creator-info',
	);

	expect(res.status).toBe(404);
});

// --- Server-side Direct Post enforcement ---------------------------------
//
// These drive the real HTTP boundary with a connection whose token actually
// decrypts, so the request reaches `creator_info/query` and the policy. They
// exist because the dashboard cannot be trusted: a replayed or hand-built form
// can claim anything, so the refusals below must hold with no UI involved.

/** Encrypt a token under the same key CONFIGURED_ENV supplies. */
async function liveConnectionRow(scopes = ['video.publish']) {
	const { createTokenCipher } = await import('./token-cipher.js');
	const { data: cipher } = await createTokenCipher([
		{ version: 1, base64Key: KEY },
	]);
	const { data: accessCiphertext } = await (
		cipher as NonNullable<typeof cipher>
	).encrypt('act.live');
	const { data: refreshCiphertext } = await (
		cipher as NonNullable<typeof cipher>
	).encrypt('rft.live');
	return {
		id: 'conn-1',
		userId: 'user-1',
		openId: 'open-abc',
		unionId: null,
		displayName: 'Braden',
		username: 'braden',
		avatarUrl: null,
		scopes,
		accessTokenCiphertext: accessCiphertext as string,
		// Comfortably fresh, so token custody never calls TikTok's token endpoint.
		accessTokenExpiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
		refreshTokenCiphertext: refreshCiphertext as string,
		refreshTokenExpiresAt: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000),
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

const CREATOR_INFO_BODY = {
	data: {
		creator_username: 'braden',
		creator_nickname: 'Braden',
		privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
		comment_disabled: false,
		duet_disabled: true,
		stitch_disabled: false,
		max_video_post_duration_sec: 600,
	},
	error: { code: 'ok' },
};

/**
 * A db whose transaction hands back the locked row, so token custody succeeds,
 * and whose insert returns a fresh publish-attempt row, so the idempotency
 * claim is WON rather than looking already-taken.
 */
function liveDb(row: Record<string, unknown>) {
	const base = fakeDb({
		selectRows: [row],
		insertRows: [
			{
				id: 'attempt-1',
				connectionId: 'conn-1',
				idempotencyKey: 'key-1',
				kind: 'direct_post',
				publishId: null,
				status: null,
			},
		],
	});
	const db = {
		...base.db,
		transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
			fn({
				select: () => ({
					from: () => ({
						where: () => ({ for: () => ({ limit: async () => [row] }) }),
					}),
				}),
				update: () => ({ set: () => ({ where: async () => undefined }) }),
			}),
	};
	return { ...base, db };
}

/** Drive one publish request with TikTok's network calls stubbed. */
async function publishWith(
	form: Record<string, string>,
	{ scopes }: { scopes?: string[] } = {},
) {
	const row = await liveConnectionRow(scopes);
	const { db } = liveDb(row);
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});

	const realFetch = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (input: string | URL) => {
		const url = String(input);
		calls.push(url);
		if (url.includes('creator_info/query')) {
			return new Response(JSON.stringify(CREATOR_INFO_BODY), { status: 200 });
		}
		// Reaching anything else means the policy admitted the request.
		return new Response(
			JSON.stringify({
				data: { publish_id: 'pub-1', upload_url: 'https://upload/x' },
				error: { code: 'ok' },
			}),
			{ status: 200 },
		);
	}) as unknown as typeof globalThis.fetch;

	try {
		const body = new FormData();
		body.set('kind', 'direct_post');
		body.set('idempotencyKey', 'key-1');
		body.set(
			'video',
			new File([new Uint8Array(64)], 'v.mp4', { type: 'video/mp4' }),
		);
		for (const [key, value] of Object.entries(form)) body.set(key, value);
		const res = await request(
			built,
			'/api/integrations/tiktok/connections/conn-1/publish',
			{ method: 'POST', body },
		);
		return { res, calls };
	} finally {
		globalThis.fetch = realFetch;
	}
}

test('server refuses branded content on a private post, with no UI involved', async () => {
	const { res, calls } = await publishWith({
		title: 'A caption',
		privacyLevel: 'SELF_ONLY',
		commercialContent: 'true',
		brandedContent: 'true',
	});

	expect(res.status).toBe(409);
	const body = (await res.json()) as {
		error: { message: string; field: string };
	};
	expect(body.error.field).toBe('commercial');
	expect(body.error.message).toContain('cannot be private');
	// Refused BEFORE the irreversible init.
	expect(calls.some((url) => url.includes('video/init'))).toBe(false);
});

test('server refuses a commercial disclosure with no kind chosen', async () => {
	const { res, calls } = await publishWith({
		title: 'A caption',
		privacyLevel: 'PUBLIC_TO_EVERYONE',
		commercialContent: 'true',
	});

	expect(res.status).toBe(409);
	const body = (await res.json()) as { error: { field: string } };
	expect(body.error.field).toBe('commercial');
	expect(calls.some((url) => url.includes('video/init'))).toBe(false);
});

test('server refuses opting in to an interaction the account disabled', async () => {
	// `duet_disabled: true` in CREATOR_INFO_BODY, read live at publish time.
	const { res } = await publishWith({
		title: 'A caption',
		privacyLevel: 'PUBLIC_TO_EVERYONE',
		allowDuet: 'true',
	});

	expect(res.status).toBe(409);
	const body = (await res.json()) as {
		error: { field: string; message: string };
	};
	expect(body.error.field).toBe('interactions');
	expect(body.error.message).toContain('Duet');
});

test('server refuses a privacy level the account is not currently offered', async () => {
	const { res } = await publishWith({
		title: 'A caption',
		privacyLevel: 'FOLLOWER_OF_CREATOR',
	});

	expect(res.status).toBe(409);
	expect(((await res.json()) as { error: { field: string } }).error.field).toBe(
		'privacyLevel',
	);
});

test('server refuses a publish with no privacy level rather than defaulting one', async () => {
	const { res } = await publishWith({ title: 'A caption' });

	expect(res.status).toBe(400);
	const body = (await res.json()) as { error: { message: string } };
	expect(body.error.message).toContain('who can see this post');
});

test('a compliant Direct Post reaches video/init', async () => {
	const { res, calls } = await publishWith({
		title: 'A caption',
		privacyLevel: 'PUBLIC_TO_EVERYONE',
		allowComment: 'true',
	});

	expect(res.status).toBe(200);
	expect(calls.some((url) => url.includes('creator_info/query'))).toBe(true);
	expect(calls.some((url) => url.includes('video/init'))).toBe(true);
});
