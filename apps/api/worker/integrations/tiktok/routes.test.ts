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
	expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');

	// The state row is bound to the initiating Epicenter user and expires.
	const state = inserted[0] as {
		state: string;
		userId: string;
		codeVerifier: string;
		expiresAt: Date;
	};
	expect(state.userId).toBe('user-42');
	expect(state.state).toBe(authorize.searchParams.get('state') ?? '');
	expect(state.expiresAt.getTime()).toBeGreaterThan(Date.now());
	// The PKCE verifier stays server-side; only its challenge travels.
	expect(url).not.toContain(state.codeVerifier);
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
				codeVerifier: 'v',
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
				codeVerifier: 'v',
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
