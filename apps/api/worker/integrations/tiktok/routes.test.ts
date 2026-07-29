import { expect, test } from 'bun:test';
import type { CloudEnv } from '@epicenter/server';
import { tiktokPublishAttempt } from '@epicenter/server/cloud-db';
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

/**
 * A minimal but REAL MP4: `ftyp` plus `moov > mvhd` carrying the duration.
 *
 * Direct Post now fails closed when the length cannot be read, so these tests
 * must hand the route a file whose duration actually parses. See
 * mp4-duration.ts.
 */
function mp4Bytes(seconds: number): Uint8Array<ArrayBuffer> {
	// Allocated over an explicit ArrayBuffer: `BlobPart` (and WebCrypto) exclude
	// SharedArrayBuffer-backed views.
	const alloc = (length: number) => new Uint8Array(new ArrayBuffer(length));
	const box = (type: string, payload: Uint8Array) => {
		const bytes = alloc(8 + payload.byteLength);
		new DataView(bytes.buffer).setUint32(0, bytes.byteLength);
		bytes.set(new TextEncoder().encode(type), 4);
		bytes.set(payload, 8);
		return bytes;
	};
	const mvhd = alloc(20);
	const view = new DataView(mvhd.buffer);
	view.setUint8(0, 0);
	view.setUint32(12, 1000);
	view.setUint32(16, seconds * 1000);
	const ftyp = box('ftyp', alloc(8));
	const moov = box('moov', box('mvhd', mvhd));
	const out = alloc(ftyp.byteLength + moov.byteLength);
	out.set(ftyp, 0);
	out.set(moov, ftyp.byteLength);
	return out;
}

/** A key that satisfies the server contract (see publish-intent.ts). */
const VALID_KEY = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

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

test('a state belonging to another Epicenter user matches nothing and attaches nothing', async () => {
	// The delete is scoped by BOTH state and user_id, so a foreign user's
	// callback selects no row at all. Modelled here the way Postgres behaves:
	// no match, therefore no row returned, therefore nothing consumed and the
	// real owner's in-flight ceremony is left intact.
	const { db } = fakeDb({ deleteReturning: [] });
	const built = createTikTokTestApp({
		session: freshSession('a-different-user'),
		env: CONFIGURED_ENV,
		db,
	});

	const realFetch = globalThis.fetch;
	const tiktokCalls: string[] = [];
	globalThis.fetch = (async (input: string | URL) => {
		tiktokCalls.push(String(input));
		return new Response('{}', { status: 200 });
	}) as unknown as typeof globalThis.fetch;

	try {
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
		// No code was exchanged: nothing reached TikTok.
		expect(tiktokCalls).toHaveLength(0);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('a callback with NO session consumes nothing and exchanges nothing', async () => {
	// Session is resolved BEFORE the state is touched, so an unauthenticated hit
	// on this URL cannot cancel anybody's in-flight ceremony.
	const { db, state } = fakeDb({ deleteReturning: [] });
	const built = createTikTokTestApp({
		session: null,
		env: CONFIGURED_ENV,
		db,
	});

	const res = await request(
		built,
		'/api/integrations/tiktok/callback?code=abc&state=s',
	);

	expect(res.status).toBe(302);
	const location = new URL(res.headers.get('Location') ?? '', ORIGIN);
	expect(location.searchParams.get('error') ?? '').toContain('Sign in');
	expect(location.searchParams.get('connected')).toBeNull();
	// Nothing was read or deleted.
	expect(state.touched).toBe(false);
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
	form.set('idempotencyKey', VALID_KEY);

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
	form.set('idempotencyKey', VALID_KEY);
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
				idempotencyKey: VALID_KEY,
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
		body.set('idempotencyKey', VALID_KEY);
		body.set(
			'video',
			// 30s, comfortably under the 600s ceiling CREATOR_INFO_BODY reports.
			new File([mp4Bytes(30)], 'v.mp4', { type: 'video/mp4' }),
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

// --- Timeout retry cannot originate a second post ------------------------
//
// The end-to-end proof for the idempotency fix. `publishWith` uses a fresh
// in-memory db per call; this one PERSISTS attempt rows across requests, which
// is what lets the second submission collide with the first claim.

/**
 * A db that remembers claimed attempts and routes selects by TABLE, so the
 * connection lookup and the conflicting-attempt read cannot answer each other.
 */
function statefulDb(connectionRow: Record<string, unknown>) {
	const claimed = new Map<string, Record<string, unknown>>();
	const statuses: string[] = [];

	const rowsFor = (table: unknown): unknown[] =>
		table === tiktokPublishAttempt ? [...claimed.values()] : [connectionRow];

	const chain = (rows: unknown[]): unknown =>
		Object.assign(Promise.resolve(rows), {
			where: () => chain(rows),
			orderBy: () => chain(rows),
			limit: () => chain(rows),
			returning: () => chain(rows),
			for: () => chain(rows),
		});

	const db = {
		select: () => ({ from: (table: unknown) => chain(rowsFor(table)) }),
		delete: () => chain([]),
		update: () => ({
			set: (values: { status?: string }) => {
				if (values.status) statuses.push(values.status);
				return { where: async () => undefined };
			},
		}),
		insert: () => ({
			values: (value: Record<string, unknown>) => ({
				onConflictDoNothing: () => ({
					// The unique (connection_id, idempotency_key) index, modelled: a
					// second insert under the same key returns NO row.
					returning: async () => {
						const key = String(value.idempotencyKey);
						if (claimed.has(key)) return [];
						claimed.set(key, { ...value, publishId: null, status: null });
						return [claimed.get(key)];
					},
				}),
			}),
		}),
		transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
			fn({
				select: () => ({
					from: () => ({
						where: () => ({
							for: () => ({ limit: async () => [connectionRow] }),
						}),
					}),
				}),
				update: () => ({ set: () => ({ where: async () => undefined }) }),
			}),
	};
	return { db, claimed, statuses };
}

/** Drive one publish against a persistent db, with TikTok's calls stubbed. */
async function submitPublish(
	built: ReturnType<typeof createTikTokTestApp>,
	idempotencyKey: string,
) {
	const body = new FormData();
	body.set('kind', 'direct_post');
	body.set('idempotencyKey', idempotencyKey);
	body.set('title', 'A caption');
	body.set('privacyLevel', 'PUBLIC_TO_EVERYONE');
	body.set('video', new File([mp4Bytes(30)], 'v.mp4', { type: 'video/mp4' }));
	return request(built, '/api/integrations/tiktok/connections/conn-1/publish', {
		method: 'POST',
		body,
	});
}

test('a timeout retry sends the SAME key and cannot reach a second video/init', async () => {
	const row = await liveConnectionRow(['video.publish']);
	const { db, claimed, statuses } = statefulDb(row);
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});

	const initCalls: string[] = [];
	let initTimesOut = true;
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL) => {
		const url = String(input);
		if (url.includes('creator_info/query')) {
			return new Response(JSON.stringify(CREATOR_INFO_BODY), { status: 200 });
		}
		if (url.includes('video/init')) {
			initCalls.push(url);
			if (initTimesOut) {
				throw new Error('The operation was aborted due to timeout');
			}
			return new Response(
				JSON.stringify({
					data: { publish_id: 'pub-1', upload_url: 'https://upload/x' },
					error: { code: 'ok' },
				}),
				{ status: 200 },
			);
		}
		return new Response(null, { status: 200 });
	}) as unknown as typeof globalThis.fetch;

	try {
		// The dashboard's keeper holds ONE key for this unchanged intent, so the
		// retry below reuses it exactly as the browser would.
		const first = await submitPublish(built, VALID_KEY);

		expect(first.status).toBe(502);
		const firstBody = (await first.json()) as {
			error: { name: string; unresolved: boolean; attemptId: string };
		};
		// Ambiguous, NOT a clean failure: TikTok may have accepted the init.
		expect(firstBody.error.name).toBe('PublishOutcomeUnknown');
		expect(firstBody.error.unresolved).toBe(true);
		expect(firstBody.error.attemptId).toBeTruthy();
		expect(statuses).toContain('INIT_AMBIGUOUS');
		expect(initCalls).toHaveLength(1);

		// The natural retry. TikTok is healthy again, so nothing but the claim
		// stands between this request and a SECOND irreversible post.
		initTimesOut = false;
		const second = await submitPublish(built, VALID_KEY);

		expect(second.status).toBe(409);
		const secondBody = (await second.json()) as {
			error: { name: string; attemptId: string };
		};
		expect(secondBody.error.name).toBe('PublishAlreadyAttempted');
		// THE POINT: init was reached exactly once across both submissions, and
		// only one attempt exists.
		expect(initCalls).toHaveLength(1);
		expect(claimed.size).toBe(1);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('a DIFFERENT key after a settled outcome is allowed to post again', async () => {
	// The mirror of the test above: idempotency must not become a permanent lock.
	// A new intent (new key) reaches init normally.
	const row = await liveConnectionRow(['video.publish']);
	const { db, claimed } = statefulDb(row);
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});

	const initCalls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL) => {
		const url = String(input);
		if (url.includes('creator_info/query')) {
			return new Response(JSON.stringify(CREATOR_INFO_BODY), { status: 200 });
		}
		if (url.includes('video/init')) initCalls.push(url);
		return new Response(
			JSON.stringify({
				data: { publish_id: 'pub-1', upload_url: 'https://upload/x' },
				error: { code: 'ok' },
			}),
			{ status: 200 },
		);
	}) as unknown as typeof globalThis.fetch;

	try {
		expect((await submitPublish(built, VALID_KEY)).status).toBe(200);
		const second = await submitPublish(
			built,
			'f9e8d7c6-b5a4-4321-9876-0f1e2d3c4b5a',
		);

		expect(second.status).toBe(200);
		expect(initCalls).toHaveLength(2);
		expect(claimed.size).toBe(2);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('a definite 4xx rejection records INIT_FAILED, not INIT_AMBIGUOUS', async () => {
	const row = await liveConnectionRow(['video.publish']);
	const { db, statuses } = statefulDb(row);
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});

	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL) => {
		const url = String(input);
		if (url.includes('creator_info/query')) {
			return new Response(JSON.stringify(CREATOR_INFO_BODY), { status: 200 });
		}
		return new Response(
			JSON.stringify({
				data: {},
				error: { code: 'invalid_param', message: 'bad title' },
			}),
			{ status: 400 },
		);
	}) as unknown as typeof globalThis.fetch;

	try {
		const res = await submitPublish(built, VALID_KEY);

		expect(res.status).toBe(502);
		// TikTok understood and refused, so nothing was created: the honest record
		// is a definite failure, and the response is the provider's own error.
		expect(statuses).toContain('INIT_FAILED');
		expect(statuses).not.toContain('INIT_AMBIGUOUS');
		const body = (await res.json()) as { error: { name: string } };
		expect(body.error.name).toBe('ProviderRejected');
	} finally {
		globalThis.fetch = realFetch;
	}
});

// --- Idempotency key contract at the boundary ----------------------------

test('an out-of-contract idempotency key is refused before anything is claimed', async () => {
	for (const key of ['', 'short', 'has space', 'x'.repeat(200), 'quote"mark']) {
		const { res, calls } = await publishWith({
			title: 'A caption',
			privacyLevel: 'PUBLIC_TO_EVERYONE',
			idempotencyKey: key,
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain('idempotencyKey');
		// Refused before TikTok was contacted at all.
		expect(calls).toHaveLength(0);
	}
});

// --- Direct Post fails closed on unreadable duration ---------------------

test('Direct Post refuses a video whose duration cannot be read', async () => {
	// TikTok makes checking length a CLIENT responsibility, so an unparseable
	// container is a check this surface did not perform, not one TikTok will
	// perform for us.
	const row = await liveConnectionRow(['video.publish']);
	const { db } = statefulDb(row);
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});

	const initCalls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL) => {
		const url = String(input);
		if (url.includes('creator_info/query')) {
			return new Response(JSON.stringify(CREATOR_INFO_BODY), { status: 200 });
		}
		if (url.includes('video/init')) initCalls.push(url);
		return new Response(null, { status: 200 });
	}) as unknown as typeof globalThis.fetch;

	try {
		const body = new FormData();
		body.set('kind', 'direct_post');
		body.set('idempotencyKey', VALID_KEY);
		body.set('title', 'A caption');
		body.set('privacyLevel', 'PUBLIC_TO_EVERYONE');
		// Not an MP4: duration is unknown.
		body.set(
			'video',
			new File([new Uint8Array(new ArrayBuffer(64))], 'v.webm', {
				type: 'video/mp4',
			}),
		);
		const res = await request(
			built,
			'/api/integrations/tiktok/connections/conn-1/publish',
			{ method: 'POST', body },
		);

		expect(res.status).toBe(409);
		const parsed = (await res.json()) as { error: { field: string } };
		expect(parsed.error.field).toBe('duration');
		expect(initCalls).toHaveLength(0);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('Direct Post refuses a video longer than the live account ceiling', async () => {
	const row = await liveConnectionRow(['video.publish']);
	const { db } = statefulDb(row);
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});

	const initCalls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL) => {
		const url = String(input);
		if (url.includes('creator_info/query')) {
			return new Response(JSON.stringify(CREATOR_INFO_BODY), { status: 200 });
		}
		if (url.includes('video/init')) initCalls.push(url);
		return new Response(null, { status: 200 });
	}) as unknown as typeof globalThis.fetch;

	try {
		const body = new FormData();
		body.set('kind', 'direct_post');
		body.set('idempotencyKey', VALID_KEY);
		body.set('title', 'A caption');
		body.set('privacyLevel', 'PUBLIC_TO_EVERYONE');
		// 700s against the 600s ceiling CREATOR_INFO_BODY reports.
		body.set(
			'video',
			new File([mp4Bytes(700)], 'v.mp4', { type: 'video/mp4' }),
		);
		const res = await request(
			built,
			'/api/integrations/tiktok/connections/conn-1/publish',
			{ method: 'POST', body },
		);

		expect(res.status).toBe(409);
		const parsed = (await res.json()) as {
			error: { field: string; message: string };
		};
		expect(parsed.error.field).toBe('duration');
		expect(parsed.error.message).toContain('600');
		expect(initCalls).toHaveLength(0);
	} finally {
		globalThis.fetch = realFetch;
	}
});
