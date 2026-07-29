import { expect, test } from 'bun:test';
import type { CloudEnv } from '@epicenter/server';
import { tiktokPublishAttempt } from '@epicenter/server/cloud-db';
import { Hono } from 'hono';
import {
	blocksNewPublish,
	requiresManualResolution,
} from './attempt-status.js';
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
	/** Rows returned by a select from any table other than the attempt table. */
	selectRows?: unknown[];
	/**
	 * Rows already recorded in `tiktok_publish_attempt` for this connection.
	 *
	 * Two different queries read this table and they mean different things, so the
	 * fake tells them apart by SHAPE, exactly as the real queries differ:
	 *
	 * - `listAttemptsBlockingNewPublish` ends at `.orderBy(...)`, and its SQL keeps
	 *   only rows that block a new publish. The fake mirrors that with
	 *   `blocksNewPublish`.
	 * - `claimPublishAttempt` reads back one row by key and ends at `.limit(1)`, so
	 *   it must see the row whatever its status.
	 *
	 * Keying on the call shape rather than on a call counter matters: a counter
	 * cannot survive two requests against one fake, and the second request's
	 * blocking read would silently go unfiltered.
	 *
	 * The SQL's own structure is verified separately in `store.test.ts`, so this
	 * mirror exercises the ROUTE rather than proving the predicate.
	 */
	attemptRows?: unknown[];
	/**
	 * The connection row as seen INSIDE a transaction (`SELECT ... FOR UPDATE`).
	 *
	 * Separate from `selectRows` because token custody and the publish claim both
	 * lock this row and the existing tests rely on custody seeing NOTHING (which is
	 * how they stop before reaching TikTok). A test that wants the claim to proceed
	 * supplies this.
	 */
	txConnectionRows?: unknown[];
	/**
	 * Rows returned by `update(...).returning()`.
	 *
	 * Defaults to ONE row, meaning the update matched. That matters now that the
	 * outcome writers report whether they wrote: an empty default would read as
	 * "refused because a human already settled this" and turn every successful
	 * publish into a 502.
	 */
	updateReturning?: unknown[];
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
	/**
	 * The attempt table, answering the blocking read by default and the
	 * by-key read-back whenever `.limit(...)` narrows it. See DbScript.attemptRows.
	 */
	const attemptChain = (all: unknown[]): unknown => {
		const blocking = all.filter((row) =>
			blocksNewPublish((row as { status?: string | null }).status ?? null),
		);
		const chain = Object.assign(Promise.resolve(blocking), {
			from: () => attemptChain(all),
			where: () => attemptChain(all),
			orderBy: () => attemptChain(all),
			limit: () => chainOf(all),
			returning: () => attemptChain(all),
			for: () => attemptChain(all),
		});
		return chain;
	};
	const db = {
		select: () => {
			state.touched = true;
			return {
				from: (table: unknown) =>
					table === tiktokPublishAttempt
						? attemptChain(script.attemptRows ?? [])
						: chainOf(script.selectRows ?? []),
			};
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
			return thenableRows(script.updateReturning ?? [{ id: 'updated' }]);
		},
		/**
		 * `ensureAccessToken` locks the row inside a transaction. The tx sees no
		 * rows here, so token custody reports `ConnectionNotFound` and the route
		 * answers 502. That is deliberate: these route tests exercise the gates
		 * BEFORE token custody, and tokens.test.ts owns the custody behavior
		 * against a fake that models the row lock.
		 */
		/**
		 * Two different callers open transactions here, so the handle models both:
		 * `ensureAccessToken` locks the connection row (and sees nothing, so token
		 * custody reports not-found and the route answers 502), and
		 * `claimPublishSlot` locks the connection row, rechecks the block, and
		 * inserts. Serialization itself is NOT modelled and cannot be: that property
		 * belongs to Postgres and is proven in store.concurrency.test.ts.
		 */
		transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
			state.touched = true;
			return fn({
				select: () => ({
					from: (table: unknown) =>
						table === tiktokPublishAttempt
							? attemptChain(script.attemptRows ?? [])
							: chainOf(script.txConnectionRows ?? []),
				}),
				insert: () => thenableRows(script.insertRows ?? []),
				update: () => thenableRows(script.selectRows ?? []),
			});
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
		['/api/integrations/tiktok/connections/conn-1/attempts', undefined],
		['/api/integrations/tiktok/connections/conn-1/publish', { method: 'POST' }],
		// Reads TikTok AND writes the reconciled attempt row, so an unauthenticated
		// hit here must not reach either side.
		['/api/integrations/tiktok/connections/conn-1/publish/pub-1', undefined],
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
	// Least privilege, asserted: exactly the three scopes the product exercises.
	// TikTok's review guidelines require every requested scope to be demonstrated,
	// so a fourth appearing here without a UI that drives it is a review failure.
	expect(authorize.searchParams.get('scope')).toBe(
		'user.info.basic,user.info.profile,video.publish',
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

test('the connections response names the creator, never a token or a provider id', async () => {
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
		connections: Record<string, unknown>[];
	};
	// The creator is named by display name and @handle, which is what tells a
	// creator with many accounts which one they are about to post as.
	expect(body.connections[0]).toMatchObject({
		id: 'conn-1',
		displayName: 'Braden',
		username: 'braden',
		// The one thing the UI needs from the grant: can this account be posted to.
		canPost: true,
	});
	// TikTok's provider ids and its raw permission vocabulary do NOT reach the
	// browser. A page that prints them reads as an internal utility, and neither
	// is a fact a creator can act on.
	expect(raw).not.toContain('open-abc');
	expect(body.connections[0]).not.toHaveProperty('openId');
	expect(body.connections[0]).not.toHaveProperty('unionId');
	expect(body.connections[0]).not.toHaveProperty('scopes');
});

test('a connection that never granted video.publish reports canPost false', async () => {
	// A creator can decline the publishing scope on TikTok's consent screen. That
	// leaves a REAL connection that simply cannot post, which the UI has to be
	// able to say without showing anybody a scope string.
	const { db } = fakeDb({ selectRows: [connectionRow(['user.info.basic'])] });
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});

	const res = await request(built, '/api/integrations/tiktok/connections');

	const body = (await res.json()) as { connections: { canPost: boolean }[] };
	expect(body.connections[0]?.canPost).toBe(false);
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
		// Not being disconnected. A real row has NULL here.
		closingAt: null,
		scopes,
		accessTokenCiphertext: 'v1.a.b',
		accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
		refreshTokenCiphertext: 'v1.a.b',
		refreshTokenExpiresAt: new Date(Date.now() + 3_600_000),
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

test('every publishing route passes the gate on video.publish alone', async () => {
	// One publishing product means one scope: `creator_info/query`, `video/init`
	// and `status/fetch` are all reachable with exactly `video.publish`. Passing
	// the gate means reaching token custody (502 against this fake) rather than
	// being refused at 403.
	const { db } = fakeDb({ selectRows: [connectionRow(['video.publish'])] });
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
});

test('a connection that did not grant video.publish is refused, with the scope named', async () => {
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
	// The scope is named so the remedy ("reconnect and approve this") is actionable
	// rather than a generic permission error from TikTok.
	expect(body.error.scope).toBe('video.publish');
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

test('publish refuses a connection whose grant lacks video.publish', async () => {
	// The creator declined the publishing scope at the consent screen.
	const { db } = fakeDb({
		selectRows: [connectionRow(['user.info.basic', 'user.info.profile'])],
	});
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});
	const form = new FormData();
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
		// Not being disconnected. A real row has NULL here.
		closingAt: null,
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
		// Locked inside the transaction by token custody AND by the publish claim,
		// which issue the same `SELECT ... FOR UPDATE` and so cannot be told apart.
		// Tests that want custody to stop early simply omit this.
		txConnectionRows: [row],
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
	// The base fake already models this transaction for both of its callers.
	return base;
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

	const chain = (rows: unknown[]): unknown =>
		Object.assign(Promise.resolve(rows), {
			where: () => chain(rows),
			orderBy: () => chain(rows),
			limit: () => chain(rows),
			returning: () => chain(rows),
			for: () => chain(rows),
		});

	/**
	 * The attempt table, told apart by call shape like `fakeDb`: the blocking read
	 * ends at `.orderBy(...)` and is filtered, the by-key read-back ends at
	 * `.limit(...)` and is not.
	 */
	const attemptChain = (): unknown => {
		const all = [...claimed.values()];
		const chainForAttempts = Object.assign(
			Promise.resolve(
				all.filter((row) =>
					blocksNewPublish((row.status as string | null) ?? null),
				),
			),
			{
				where: () => attemptChain(),
				orderBy: () => attemptChain(),
				limit: () => chain(all),
				returning: () => attemptChain(),
				for: () => attemptChain(),
			},
		);
		return chainForAttempts;
	};

	const db = {
		select: () => ({
			from: (table: unknown) =>
				table === tiktokPublishAttempt
					? attemptChain()
					: chain([connectionRow]),
		}),
		delete: () => chain([]),
		update: () => ({
			set: (values: { status?: string; publishId?: string | null }) => {
				if (values.status) statuses.push(values.status);
				/**
				 * Applied to the claimed row, not just logged. The route records
				 * PROCESSING_UPLOAD after a successful init, and a fake that left the
				 * row at `null` would make every subsequent submit look blocked by an
				 * unknown outcome that had in fact been answered.
				 */
				const latest = [...claimed.values()].at(-1);
				if (latest) {
					if (values.status) latest.status = values.status;
					if (values.publishId !== undefined) {
						latest.publishId = values.publishId;
					}
				}
				// `.returning()` matters: the outcome writers report whether a row moved,
				// and an empty result means "a human already settled this".
				return {
					where: () => chain(latest ? [{ id: latest.id }] : []),
				};
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
		/**
		 * Serves token custody AND the publish claim, which issue the same locking
		 * read. Inside the transaction the claim rechecks the block and inserts, so
		 * the handle routes by table exactly as the outer db does.
		 */
		transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
			fn({
				select: () => ({
					from: (table: unknown) =>
						table === tiktokPublishAttempt
							? attemptChain()
							: chain([connectionRow]),
				}),
				insert: () => db.insert(),
				update: () => db.update(),
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
			error: { name: string; blockingStatus: string | null };
		};
		/**
		 * Met by the BLOCK rather than by the idempotency latch, because the first
		 * attempt recorded INIT_AMBIGUOUS and that outcome cannot be stated. The
		 * block fires earlier (before `creator_info`, let alone `video/init`) and is
		 * the stronger of the two guards: the latch stops this exact intent, while
		 * the block stops ANY new post to the account until the unknown outcome is
		 * settled.
		 */
		expect(secondBody.error.name).toBe('PublishBlockedByUnsettledOutcome');
		expect(secondBody.error.blockingStatus).toBe('INIT_AMBIGUOUS');
		// THE POINT, unchanged: init was reached exactly once across both
		// submissions, and only one attempt exists.
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

// --- Following a post to its outcome -------------------------------------
//
// The gap these close: before this, reading TikTok's status told the CREATOR
// what happened but left the stored attempt frozen at whatever it was when the
// request returned. A creator who reloaded saw "processing" forever, even though
// TikTok had finished minutes earlier. The read is now also the write.

/**
 * Drive one status read against a stubbed `status/fetch`, capturing whatever the
 * route tried to persist.
 *
 * `attemptMatched` models the two real cases: the ordinary one where the
 * publish id belongs to a recorded attempt, and the documented pathological one
 * where TikTok created the task but recording its publish id failed, so there is
 * nothing local to reconcile.
 */
async function statusWith(
	statusBody: string,
	{
		attemptMatched = true,
		updateThrows = false,
	}: { attemptMatched?: boolean; updateThrows?: boolean } = {},
) {
	const row = await liveConnectionRow(['video.publish']);
	const base = liveDb(row);
	const writes: Record<string, unknown>[] = [];
	const db = {
		...base.db,
		// Only `reconcileAttemptFromRemote` reaches this: token custody updates
		// through the transaction handle `liveDb` supplies.
		update: () => ({
			set: (values: Record<string, unknown>) => {
				if (updateThrows) throw new Error('postgres is unreachable');
				writes.push(values);
				return {
					where: () => ({
						returning: async () =>
							attemptMatched ? [{ id: 'attempt-1' }] : [],
					}),
				};
			},
		}),
	};
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});

	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(statusBody, {
			status: 200,
		})) as unknown as typeof globalThis.fetch;
	try {
		const res = await request(
			built,
			'/api/integrations/tiktok/connections/conn-1/publish/pub-1',
		);
		return { res, writes };
	} finally {
		globalThis.fetch = realFetch;
	}
}

test('a completed publish is written into the attempt row, not merely returned', async () => {
	// A real post id is 19 digits, past Number.MAX_SAFE_INTEGER, and arrives as a
	// bare JSON number. It must survive into the STORED row exactly, or the thing
	// we saved names no post.
	const { res, writes } = await statusWith(
		'{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7382910473829104721]},"error":{"code":"ok"}}',
	);

	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		code: string;
		publicPostIds: string[];
		recorded: boolean;
	};
	expect(body.code).toBe('PUBLISH_COMPLETE');
	expect(body.publicPostIds).toEqual(['7382910473829104721']);
	expect(body.recorded).toBe(true);

	// The durable row now agrees with TikTok. This is the assertion that would
	// have failed before: the row kept saying PROCESSING_UPLOAD.
	expect(writes).toHaveLength(1);
	expect(writes[0]).toMatchObject({
		status: 'PUBLISH_COMPLETE',
		publicPostIds: ['7382910473829104721'],
		failReason: null,
	});
});

test("a failed publish records TikTok's own reason", async () => {
	const { res, writes } = await statusWith(
		'{"data":{"status":"FAILED","fail_reason":"picture_size_check_failed"},"error":{"code":"ok"}}',
	);

	expect(res.status).toBe(200);
	expect(writes[0]).toMatchObject({
		status: 'FAILED',
		failReason: 'picture_size_check_failed',
		// Read, and TikTok named no public post. An empty array is a different fact
		// from `null` (never read), and the difference is why the column is nullable.
		publicPostIds: [],
	});
});

test('a status still in flight is recorded too, so a reload tracks TikTok', async () => {
	const { writes } = await statusWith(
		'{"data":{"status":"PROCESSING_DOWNLOAD"},"error":{"code":"ok"}}',
	);

	expect(writes[0]).toMatchObject({ status: 'PROCESSING_DOWNLOAD' });
});

test('a publish id matching no recorded attempt still returns TikTok’s answer', async () => {
	// The documented window: TikTok created the task, persisting its publish id
	// failed. There is nothing to reconcile, and the outcome is still the single
	// most useful thing we can tell the creator.
	const { res } = await statusWith(
		'{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7382910473829104721]},"error":{"code":"ok"}}',
		{ attemptMatched: false },
	);

	expect(res.status).toBe(200);
	const body = (await res.json()) as { code: string; recorded: boolean };
	expect(body.code).toBe('PUBLISH_COMPLETE');
	// Reported honestly rather than implied: this outcome is not being remembered.
	expect(body.recorded).toBe(false);
});

test('a database failure never withholds the outcome TikTok reported', async () => {
	// Losing the write is bad; withholding "your post is live" because the write
	// failed is worse, and would push the creator toward posting again.
	const { res } = await statusWith(
		'{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7382910473829104721]},"error":{"code":"ok"}}',
		{ updateThrows: true },
	);

	expect(res.status).toBe(200);
	const body = (await res.json()) as { code: string; recorded: boolean };
	expect(body.code).toBe('PUBLISH_COMPLETE');
	expect(body.recorded).toBe(false);
});

// --- One consent, at most one post ---------------------------------------
//
// The hard invariant. These drive the exact sequences that could break it.

/**
 * The attempt table, told apart by call shape: the blocking recheck ends at
 * `.orderBy`/`.limit(1)` after a filtered read, the by-key read-back is
 * unfiltered. Mirrors `DbScript.attemptRows`.
 */
function attemptChainOver(all: unknown[]): unknown {
	const blocking = all.filter((row) =>
		blocksNewPublish((row as { status?: string | null }).status ?? null),
	);
	const chain = Object.assign(Promise.resolve(blocking), {
		from: () => attemptChainOver(all),
		where: () => attemptChainOver(all),
		orderBy: () => attemptChainOver(all),
		limit: () => chainReturning(all),
		returning: () => attemptChainOver(all),
		for: () => attemptChainOver(all),
	});
	return chain;
}

/** A minimal awaitable drizzle-ish chain returning fixed rows. */
function chainReturning(rows: unknown[]): unknown {
	const chain: unknown = Object.assign(Promise.resolve(rows), {
		from: () => chain,
		where: () => chain,
		orderBy: () => chain,
		limit: () => chain,
		returning: () => chain,
		for: () => chain,
		set: () => chain,
		values: () => chain,
		onConflictDoUpdate: () => chain,
		onConflictDoNothing: () => chain,
	});
	return chain;
}

/**
 * Submit a publish while ONE prior attempt sits at `priorStatus`, counting how
 * many times the irreversible `video/init` is reached.
 *
 * `submittedKey` decides which guard is under test. Reusing the prior attempt's
 * key exercises the idempotency latch; a fresh key exercises the server-side
 * block, which is the guard a direct client cannot skip.
 */
async function publishWithPriorAttempt({
	priorStatus,
	submittedKey,
	priorKey = VALID_KEY,
}: {
	priorStatus: string | null;
	submittedKey: string;
	priorKey?: string;
}) {
	const row = await liveConnectionRow(['video.publish']);
	const prior = {
		id: 'attempt-prior',
		connectionId: 'conn-1',
		idempotencyKey: priorKey,
		kind: 'direct_post',
		// Only an init that answered could have named a task.
		publishId: priorStatus === 'UPLOAD_FAILED' ? 'pub-prior' : null,
		status: priorStatus,
	};
	const base = fakeDb({
		selectRows: [row],
		attemptRows: [prior],
		// `ON CONFLICT DO NOTHING ... RETURNING` yields no row when the key is
		// already claimed, and a row when it is not.
		insertRows: [],
	});
	const claimInsert = () =>
		submittedKey === priorKey
			? chainReturning([])
			: chainReturning([
					{
						id: 'attempt-new',
						connectionId: 'conn-1',
						idempotencyKey: submittedKey,
						kind: 'direct_post',
						publishId: null,
						status: null,
					},
				]);
	const db = {
		...base.db,
		insert: claimInsert,
		transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
			fn({
				select: () => ({
					from: (table: unknown) =>
						table === tiktokPublishAttempt
							? // The claim's recheck, filtered the way the SQL filters, and then
								// its by-key read-back (which ends at `.limit`) unfiltered.
								attemptChainOver([prior])
							: chainReturning([{ ...row, closingAt: null }]),
				}),
				insert: claimInsert,
				update: () => chainReturning([{ id: 'attempt-new' }]),
			}),
	};
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
				data: { publish_id: 'pub-new', upload_url: 'https://upload/x' },
				error: { code: 'ok' },
			}),
			{ status: 200 },
		);
	}) as unknown as typeof globalThis.fetch;

	try {
		const body = new FormData();
		body.set('idempotencyKey', submittedKey);
		body.set('title', 'A caption');
		body.set('privacyLevel', 'PUBLIC_TO_EVERYONE');
		body.set('video', new File([mp4Bytes(30)], 'v.mp4', { type: 'video/mp4' }));
		const res = await request(
			built,
			'/api/integrations/tiktok/connections/conn-1/publish',
			{ method: 'POST', body },
		);
		return { res, initCalls };
	} finally {
		globalThis.fetch = realFetch;
	}
}

const FRESH_KEY = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

// --- The block must live on the SERVER, not only in Svelte ---------------
//
// The dashboard derives its block from the attempt rows, but a browser deriving a
// block is a courtesy, not a guarantee. A direct or hostile client changes one
// field, mints a fresh idempotency key, and never runs that UI. The idempotency
// latch does not catch it either: a new key is by definition a new claim, so
// `video/init` would be reached a second time while the first outcome was still
// unknown.

test.each([
	['a null status (Worker died before recording)', null],
	['INIT_AMBIGUOUS (init answer lost)', 'INIT_AMBIGUOUS'],
	['UPLOAD_FAILED (task exists, bytes may not have landed)', 'UPLOAD_FAILED'],
	['a future TikTok status this build does not know', 'SOME_FUTURE_CODE'],
])('a FRESH key is refused while a prior attempt sits at %s, and never reaches init', async (_label, priorStatus) => {
	const { res, initCalls } = await publishWithPriorAttempt({
		priorStatus: priorStatus as string | null,
		submittedKey: FRESH_KEY,
	});

	expect(res.status).toBe(409);
	const body = (await res.json()) as {
		error: { name: string; code: string; message: string };
	};
	expect(body.error.name).toBe('PublishBlockedByUnsettledOutcome');
	expect(body.error.code).toBe('BLOCKED_BY_UNSETTLED_OUTCOME');
	// The creator-facing reason survives rather than a bare status code.
	expect(body.error.message).toContain('second copy');
	// The whole point: TikTok's irreversible call was never made.
	expect(initCalls).toHaveLength(0);
});

test.each([
	['PROCESSING_UPLOAD', 'PROCESSING_UPLOAD'],
	['PROCESSING_DOWNLOAD', 'PROCESSING_DOWNLOAD'],
	['PUBLISH_COMPLETE', 'PUBLISH_COMPLETE'],
	['FAILED', 'FAILED'],
	['INIT_FAILED', 'INIT_FAILED'],
	['RESOLVED_NOT_POSTED', 'RESOLVED_NOT_POSTED'],
])('a genuinely new consent still posts while a prior attempt sits at %s', async (_label, priorStatus) => {
	// A post TikTok is processing, or one that settled either way, is a
	// STATEABLE outcome. Blocking on those would stop a creator posting a second
	// video for no safety gain.
	const { res, initCalls } = await publishWithPriorAttempt({
		priorStatus,
		submittedKey: FRESH_KEY,
	});

	expect(res.status).toBe(200);
	expect(initCalls).toHaveLength(1);
});

// --- The idempotency latch, for statuses that do not block ---------------

test.each([
	['PROCESSING_UPLOAD', 'PROCESSING_UPLOAD'],
	['PROCESSING_DOWNLOAD', 'PROCESSING_DOWNLOAD'],
])('a same-key resubmit against %s reports UNRESOLVED so the claim is kept', async (_label, priorStatus) => {
	// These do not block, so the LATCH is what refuses. It must still report the
	// outcome as unsettled: this intent has already committed a post, and a
	// client that read the 409 as a definite refusal would release its key and
	// let the next submit originate a second one.
	const { res, initCalls } = await publishWithPriorAttempt({
		priorStatus,
		submittedKey: VALID_KEY,
	});

	expect(res.status).toBe(409);
	const body = (await res.json()) as {
		error: { name: string; unresolved: boolean; status: string | null };
	};
	expect(body.error.name).toBe('PublishAlreadyAttempted');
	expect(body.error.unresolved).toBe(true);
	expect(body.error.status).toBe(priorStatus);
	expect(initCalls).toHaveLength(0);
});

test.each([
	['PUBLISH_COMPLETE', 'PUBLISH_COMPLETE'],
	['FAILED', 'FAILED'],
	['INIT_FAILED', 'INIT_FAILED'],
	['RESOLVED_NOT_POSTED', 'RESOLVED_NOT_POSTED'],
])('a same-key resubmit against settled %s releases the claim', async (_label, priorStatus) => {
	// This intent genuinely finished, so an identical repost is a deliberate
	// second post rather than a duplicate.
	const { res } = await publishWithPriorAttempt({
		priorStatus,
		submittedKey: VALID_KEY,
	});

	expect(res.status).toBe(409);
	const body = (await res.json()) as { error: { unresolved: boolean } };
	expect(body.error.unresolved).toBe(false);
});

test.each([
	['a null status', null],
	['INIT_AMBIGUOUS', 'INIT_AMBIGUOUS'],
	['UPLOAD_FAILED', 'UPLOAD_FAILED'],
])('a same-key resubmit against %s meets the BLOCK, which fires before the latch', async (_label, priorStatus) => {
	// Both guards would refuse. The block runs first because it is the broader
	// one, and it reaches zero provider calls.
	const { res, initCalls } = await publishWithPriorAttempt({
		priorStatus: priorStatus as string | null,
		submittedKey: VALID_KEY,
	});

	expect(res.status).toBe(409);
	const body = (await res.json()) as { error: { name: string } };
	expect(body.error.name).toBe('PublishBlockedByUnsettledOutcome');
	expect(initCalls).toHaveLength(0);
});

test('cross-account posting stays allowed while one account is blocked', async () => {
	// The block is per-connection by design: an unknown outcome on one account
	// cannot be duplicated by posting to a different one, so refusing here would
	// punish without protecting anything.
	const row = await liveConnectionRow(['video.publish']);
	const base = fakeDb({
		selectRows: [{ ...row, id: 'conn-2' }],
		// conn-2's own attempt table is empty; the blocked account is conn-1.
		attemptRows: [],
		insertRows: [
			{
				id: 'attempt-2',
				connectionId: 'conn-2',
				idempotencyKey: FRESH_KEY,
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
					from: (table: unknown) =>
						table === tiktokPublishAttempt
							? chainReturning([])
							: chainReturning([{ ...row, id: 'conn-2' }]),
				}),
				insert: () => base.db.insert(),
				update: () => chainReturning([{ id: 'attempt-2' }]),
			}),
	};
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
				data: { publish_id: 'pub-2', upload_url: 'https://upload/x' },
				error: { code: 'ok' },
			}),
			{ status: 200 },
		);
	}) as unknown as typeof globalThis.fetch;

	try {
		const body = new FormData();
		body.set('idempotencyKey', FRESH_KEY);
		body.set('title', 'A caption');
		body.set('privacyLevel', 'PUBLIC_TO_EVERYONE');
		body.set('video', new File([mp4Bytes(30)], 'v.mp4', { type: 'video/mp4' }));
		const res = await request(
			built,
			'/api/integrations/tiktok/connections/conn-2/publish',
			{ method: 'POST', body },
		);

		expect(res.status).toBe(200);
		expect(initCalls).toHaveLength(1);
	} finally {
		globalThis.fetch = realFetch;
	}
});

// --- Disconnect must not destroy custody ---------------------------------

/** A db that reports the given unsettled attempts for the disconnect check. */
/**
 * A db for the disconnect path, whose locking transaction models
 * `beginConnectionClose`: lock the connection, read the unsettled attempts, then
 * mark `closing_at`.
 */
function disconnectDb(row: Record<string, unknown>, unsettled: unknown[]) {
	const base = fakeDb({ selectRows: [row] });
	const deleted: string[] = [];
	const marked: Record<string, unknown>[] = [];
	const db = {
		...base.db,
		delete: () => {
			deleted.push('connection');
			return chainReturning([{ id: 'conn-1' }]);
		},
		transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
			fn({
				select: () => ({
					from: (table: unknown) =>
						table === tiktokPublishAttempt
							? chainReturning(unsettled)
							: chainReturning([{ ...row, closingAt: null }]),
				}),
				update: () => ({
					set: (values: Record<string, unknown>) => {
						marked.push(values);
						return chainReturning([
							{ ...row, closingAt: values.closingAt ?? new Date() },
						]);
					},
				}),
			}),
	};
	return { db, deleted, marked };
}

test('disconnect is REFUSED while an attempt has no settled outcome', async () => {
	// The attempt table cascades on the connection, so deleting it here would
	// destroy the only record that TikTok may be holding a post, and revoking the
	// token would remove any way to ever ask.
	const row = await liveConnectionRow(['video.publish']);
	const { db, deleted } = disconnectDb(row, [
		{ id: 'attempt-1', status: 'INIT_AMBIGUOUS', publishId: null },
	]);
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});

	const res = await request(
		built,
		'/api/integrations/tiktok/connections/conn-1',
		{
			method: 'DELETE',
		},
	);

	expect(res.status).toBe(409);
	const body = (await res.json()) as {
		error: { name: string; code: string; unsettled: number };
	};
	expect(body.error.name).toBe('ConnectionHasUnsettledPublish');
	expect(body.error.code).toBe('UNSETTLED_PUBLISH');
	expect(body.error.unsettled).toBe(1);
	// Nothing was deleted, and TikTok was never asked to revoke.
	expect(deleted).toHaveLength(0);
});

test('disconnect proceeds once every attempt has settled', async () => {
	const row = await liveConnectionRow(['video.publish']);
	const { db, deleted } = disconnectDb(row, []);
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});

	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ error: { code: 'ok' } }), {
			status: 200,
		})) as unknown as typeof globalThis.fetch;
	try {
		const res = await request(
			built,
			'/api/integrations/tiktok/connections/conn-1',
			{ method: 'DELETE' },
		);

		expect(res.status).toBe(200);
		expect(deleted).toContain('connection');
	} finally {
		globalThis.fetch = realFetch;
	}
});

// --- The only exit from an unpollable ambiguous attempt ------------------

/**
 * A db whose manual-resolution update honours the same allowlist the SQL does:
 * the row moves only when no task was named AND no answer has arrived.
 *
 * Modelled rather than hardcoded to a boolean, because "which rows may a human
 * overwrite" is the thing under test. `store.test.ts` verifies the SQL that
 * enforces it, including its parenthesization.
 */
function resolveDb(
	connection: Record<string, unknown>,
	attempt: {
		status: string | null;
		publishId: string | null;
		/** Expired by default: these tests are about the status allowlist, and the
		 * lease boundary itself is proven against real Postgres. */
		leaseExpiresAt?: Date | null;
	},
) {
	const base = fakeDb({ selectRows: [connection] });
	const writes: Record<string, unknown>[] = [];
	const db = {
		...base.db,
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: () => ({
					returning: async () => {
						if (
							!requiresManualResolution(
								{
									...attempt,
									leaseExpiresAt:
										attempt.leaseExpiresAt ?? new Date(Date.now() - 1_000),
								},
								Date.now(),
							)
						) {
							return [];
						}
						writes.push(values);
						return [{ id: 'attempt-1' }];
					},
				}),
			}),
		}),
	};
	return { db, writes };
}

async function postResolution(
	db: unknown,
	outcome: unknown,
	attemptId = 'attempt-1',
) {
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});
	return request(
		built,
		`/api/integrations/tiktok/connections/conn-1/attempts/${attemptId}/resolve`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ outcome }),
		},
	);
}

test('a creator can record that an unpollable attempt did post', async () => {
	// Without this the honest block on INIT_AMBIGUOUS becomes a permanent trap:
	// no publish id means nothing can be polled, so only a human can close it.
	const row = await liveConnectionRow(['video.publish']);
	const { db, writes } = resolveDb(row, { status: null, publishId: null });

	const res = await postResolution(db, 'RESOLVED_POSTED');

	expect(res.status).toBe(200);
	// Stored as a HUMAN's assertion, never as TikTok's own PUBLISH_COMPLETE.
	expect(writes[0]).toMatchObject({ status: 'RESOLVED_POSTED' });
});

test('a creator can record that an unpollable attempt did NOT post', async () => {
	const row = await liveConnectionRow(['video.publish']);
	const { db, writes } = resolveDb(row, {
		status: 'INIT_AMBIGUOUS',
		publishId: null,
	});

	const res = await postResolution(db, 'RESOLVED_NOT_POSTED');

	expect(res.status).toBe(200);
	expect(writes[0]).toMatchObject({ status: 'RESOLVED_NOT_POSTED' });
});

test('a resolution cannot claim TikTok’s own vocabulary', async () => {
	// Writing PUBLISH_COMPLETE by hand would launder a guess into provider truth.
	const row = await liveConnectionRow(['video.publish']);
	const { db, writes } = resolveDb(row, { status: null, publishId: null });

	const res = await postResolution(db, 'PUBLISH_COMPLETE');

	expect(res.status).toBe(400);
	expect(writes).toHaveLength(0);
});

test('a resolution that lost the race to TikTok is refused', async () => {
	// The store only moves a row that is still unsettled, so a status that
	// arrived from TikTok in the meantime wins.
	const row = await liveConnectionRow(['video.publish']);
	// TikTok answered while the creator was deciding.
	const { db } = resolveDb(row, {
		status: 'PUBLISH_COMPLETE',
		publishId: 'pub-1',
	});

	const res = await postResolution(db, 'RESOLVED_POSTED');

	expect(res.status).toBe(409);
	const body = (await res.json()) as { error: { name: string } };
	expect(body.error.name).toBe('AttemptAlreadySettled');
});

test('resolving an attempt on a connection you do not own reads as not found', async () => {
	const { db } = fakeDb({ selectRows: [] });

	const res = await postResolution(db, 'RESOLVED_POSTED');

	expect(res.status).toBe(404);
});

test.each([
	['a post TikTok is still processing', 'PROCESSING_UPLOAD', null],
	['a post TikTok is downloading', 'PROCESSING_DOWNLOAD', null],
	['an upload failure whose task IS named', 'UPLOAD_FAILED', 'pub-1'],
	['any row that names a task', null, 'pub-1'],
	['an INIT_AMBIGUOUS row that names a task', 'INIT_AMBIGUOUS', 'pub-1'],
	['a status this build has never seen', 'SOME_FUTURE_CODE', null],
	['an outcome TikTok already gave', 'FAILED', null],
])('a human cannot overwrite %s', async (_label, status, publishId) => {
	/**
	 * The old WHERE was `status NOT IN (terminal)`, which admitted every one of
	 * these. Each would have let somebody's assertion replace state the provider
	 * had reported or could still be asked about, which is the one thing a manual
	 * resolution must never do.
	 */
	const row = await liveConnectionRow(['video.publish']);
	const { db, writes } = resolveDb(row, {
		status: status as string | null,
		publishId: publishId as string | null,
	});

	const res = await postResolution(db, 'RESOLVED_NOT_POSTED');

	expect(res.status).toBe(409);
	expect(writes).toHaveLength(0);
});

test('a connection mid-disconnect is reported as closing, not merely unpostable', async () => {
	// `closing_at` is never cleared, so an interrupted disconnect leaves an account
	// that refuses posts. A creator who only discovered that by having a post
	// refused would have no way to understand or fix it.
	const { db } = fakeDb({
		selectRows: [
			{ ...connectionRow(['video.publish']), closingAt: new Date() },
		],
	});
	const built = createTikTokTestApp({
		session: freshSession('user-1'),
		env: CONFIGURED_ENV,
		db,
	});

	const res = await request(built, '/api/integrations/tiktok/connections');

	const body = (await res.json()) as {
		connections: { closing: boolean; canPost: boolean }[];
	};
	expect(body.connections[0]?.closing).toBe(true);
	// Still a real grant: the refusal is about the disconnect, not the scope.
	expect(body.connections[0]?.canPost).toBe(true);
});
