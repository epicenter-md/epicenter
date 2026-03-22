import { env } from 'cloudflare:workers';
import {
	oauthProvider,
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { customSession } from 'better-auth/plugins';
import { bearer } from 'better-auth/plugins/bearer';
import { deviceAuthorization } from 'better-auth/plugins/device-authorization';
import { jwt } from 'better-auth/plugins/jwt';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { createFactory } from 'hono/factory';
import { describeRoute } from 'hono-openapi';
import pg from 'pg';
import { APPS } from '@epicenter/constants/apps';
import { aiChatHandlers } from './ai-chat';
import {
	renderConsentPage,
	renderDevicePage,
	renderSignedInPage,
	renderSignInPage,
} from './auth-pages';
import { createAutumn } from './autumn';
import { billing } from './billing';
import { MAX_PAYLOAD_BYTES } from './constants';
import * as schema from './db/schema';

export { DocumentRoom } from './document-room';
// Re-export so wrangler types generates DurableObjectNamespace<WorkspaceRoom|DocumentRoom>
export { WorkspaceRoom } from './workspace-room';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Db = NodePgDatabase<typeof schema>;
type Auth = ReturnType<typeof createAuth>;
type Session = Auth['$Infer']['Session'];

/**
 * Create a queue for fire-and-forget promises that run after the HTTP response.
 *
 * Route handlers push promises into the queue via `push()`. The middleware's
 * `finally` block calls `drain()` inside `executionCtx.waitUntil()` to keep
 * the worker alive until all promises settle. Cleanup (e.g. closing the DB
 * connection) is chained by the caller via `.then()`.
 *
 * @example
 * ```typescript
 * const afterResponse = createAfterResponseQueue();
 * c.set('afterResponse', afterResponse);
 * // ... await next() ...
 * c.executionCtx.waitUntil(afterResponse.drain().then(() => client.end()));
 * ```
 */
function createAfterResponseQueue() {
	/**
	 * Tracked promises whose resolution values are intentionally ignored.
	 * `unknown` is the semantic contract for fire-and-forget: we track these
	 * promises to completion via `Promise.allSettled`, but never inspect what
	 * they resolve to.
	 */
	const promises: Promise<unknown>[] = [];
	return {
		/** Enqueue a fire-and-forget promise to run after the response is sent. */
		push(promise: Promise<unknown>) {
			promises.push(promise);
		},
		/** Settle all queued promises. Returns a single promise suitable for `executionCtx.waitUntil()`. */
		drain() {
			return Promise.allSettled(promises);
		},
	};
}

type AfterResponseQueue = ReturnType<typeof createAfterResponseQueue>;

export type Env = {
	Bindings: Cloudflare.Env;
	Variables: {
		db: Db;
		auth: Auth;
		user: Session['user'];
		session: Session['session'];
		afterResponse: AfterResponseQueue;
	};
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Shared base config for Better Auth — used by both the runtime and the CLI schema tool. */
export const BASE_AUTH_CONFIG = {
	basePath: '/auth',
	emailAndPassword: { enabled: true },
	account: {
		accountLinking: {
			enabled: true,
			trustedProviders: ['google', 'email-password'],
		},
	},
} satisfies BetterAuthOptions;

/**
 * Validated shape of a single keyring entry.
 *
 * `version` is a positive integer identifying the key generation; `secret` is
 * the raw key material (typically base64-encoded via `openssl rand -base64 32`).
 */
const EncryptionEntry = type({
	version: 'number.integer > 0',
	secret: 'string',
});

/**
 * Parse a single `"version:secret"` string into a validated `EncryptionEntry`.
 *
 * Finds the first colon—everything before it is the version, everything after
 * is the secret (which may itself contain colons). Uses `ctx.error()` for
 * arktype-native error reporting when the colon delimiter is missing.
 */
const EncryptionEntryParser = type('string')
	.pipe((entry, ctx) => {
		const i = entry.indexOf(':');
		if (i === -1) return ctx.error('must be "version:secret"');
		return { version: Number(entry.slice(0, i)), secret: entry.slice(i + 1) };
	})
	.to(EncryptionEntry);

/**
 * Parse and validate the full ENCRYPTION_SECRETS env var into a sorted keyring.
 *
 * Input format: `"2:base64Secret2,1:base64Secret1"` (comma-separated entries).
 * Output: a non-empty array of `{ version, secret }` sorted by version descending
 * (highest version first—the current key for new encryptions).
 *
 * `.pipe.try()` catches any `TraversalError` thrown by `EncryptionEntryParser.assert()`
 * and wraps it as `ArkErrors`. The non-empty tuple `.to()` guarantees `keyring[0]`
 * is always defined. `.assert()` at module load throws a `TraversalError` if the
 * env var is missing or malformed—the worker won’t serve requests until fixed.
 *
 * @example
 * ```
 * // ENCRYPTION_SECRETS="2:newSecret,1:oldSecret"
 * keyring[0] // { version: 2, secret: "newSecret" }  (current key)
 * keyring[1] // { version: 1, secret: "oldSecret" }  (for decrypting old blobs)
 * ```
 */
const EncryptionKeyring = type('string')
	.pipe.try((s) =>
		s
			.split(',')
			.map((e) => EncryptionEntryParser.assert(e))
			.sort((a, b) => b.version - a.version),
	)
	.to([EncryptionEntry, '...', EncryptionEntry.array()]);

/**
 * Module-scope keyring—parsed once when the worker loads.
 *
 * `cloudflare:workers` exposes `env` at module scope. Parsing here means a
 * malformed ENCRYPTION_SECRETS prevents the worker from loading at all (no
 * requests served) rather than failing on the first auth check.
 */
const keyring = EncryptionKeyring.assert(env.ENCRYPTION_SECRETS);
const currentKey = keyring[0];

/**
 * Derive a per-user 32-byte encryption key via two-step HKDF-SHA256.
 *
 * 1. SHA-256 the secret to get high-entropy root key material.
 * 2. Import as HKDF key and derive 256 bits with info="user:{userId}".
 *
 * Same inputs always produce the same key—deterministic, no storage needed.
 *
 * The info string is a domain-separation label for HKDF (RFC 5869 §3.2),
 * not a version identifier. If the derivation scheme ever changes (hash
 * algorithm, salt policy), the blob format version handles migration—not
 * the info string. Vault Transit, Signal Protocol, libsodium, and AWS KMS
 * all use unversioned derivation context strings.
 */
async function deriveUserKey(
	secret: string,
	userId: string,
): Promise<Uint8Array> {
	const rawKey = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(secret),
	);
	const hkdfKey = await crypto.subtle.importKey('raw', rawKey, 'HKDF', false, [
		'deriveBits',
	]);
	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new Uint8Array(0),
			info: new TextEncoder().encode(`user:${userId}`),
		},
		hkdfKey,
		256,
	);
	return new Uint8Array(derivedBits);
}

/** Convert bytes to base64 string for JSON transport. */
function bytesToBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

/** Creates a Better Auth instance using an already-connected Drizzle instance. */
function createAuth({ db, env, baseURL }: { db: Db; env: Env['Bindings']; baseURL: string }) {
	return betterAuth({
		...BASE_AUTH_CONFIG,
		database: drizzleAdapter(db, { provider: 'pg' }),
		baseURL,
		secret: env.BETTER_AUTH_SECRET,
		socialProviders: {
			google: {
				clientId: env.GOOGLE_CLIENT_ID,
				clientSecret: env.GOOGLE_CLIENT_SECRET,
			},
		},
		plugins: [
			bearer(),
			jwt(),
			customSession(async ({ user, session }) => {
				const encryptionKey = await deriveUserKey(currentKey.secret, user.id);
				return {
					user,
					session,
					encryptionKey: bytesToBase64(encryptionKey),
					keyVersion: currentKey.version,
				};
			}),
			deviceAuthorization({
				verificationUri: '/device',
				expiresIn: '10m',
				interval: '5s',
			}),
			oauthProvider({
				loginPage: '/sign-in',
				consentPage: '/consent',
				requirePKCE: true,
				allowDynamicClientRegistration: false,
				trustedClients: [
					{
						clientId: 'epicenter-desktop',
						name: 'Epicenter Desktop',
						type: 'native',
						redirectUrls: ['tauri://localhost/auth/callback'],
						skipConsent: true,
						metadata: {},
					},
					{
						clientId: 'epicenter-mobile',
						name: 'Epicenter Mobile',
						type: 'native',
						redirectUrls: ['epicenter://auth/callback'],
						skipConsent: true,
						metadata: {},
					},
					{
						clientId: 'epicenter-runner',
						name: 'Epicenter Runner',
						type: 'native',
						redirectUrls: [],
						skipConsent: true,
						metadata: {},
					},
				],
			}),
		],
		session: {
			expiresIn: 60 * 60 * 24 * 7,
			updateAge: 60 * 60 * 24,
			storeSessionInDatabase: true,
			cookieCache: {
				enabled: true,
				maxAge: 60 * 5,
				strategy: 'jwe',
			},
		},
		advanced: {
			crossSubDomainCookies: {
				enabled: true,
				domain: 'epicenter.so',
			},
		},
		trustedOrigins: (request) => {
			const origins = [
				'tauri://localhost',
				...Object.values(APPS).flatMap((a) => [a.url, `http://localhost:${a.port}`]),
			];
			const origin = request?.headers.get('origin');
			if (origin?.startsWith('chrome-extension://')) {
				origins.push(origin);
			}
			return origins;
		},
		secondaryStorage: {
			get: (key: string) => env.SESSION_KV.get(key),
			set: (key: string, value: string, ttl?: number) =>
				env.SESSION_KV.put(key, value, {
					expirationTtl: ttl ?? 60 * 5,
				}),
			delete: (key: string) => env.SESSION_KV.delete(key),
		},
	});
}

// ---------------------------------------------------------------------------
// Factory & App
// ---------------------------------------------------------------------------

const factory = createFactory<Env>({
	initApp: (app) => {
		// CORS — skip WebSocket upgrades (101 response headers are immutable).
		// Allowed origins derived from APPS so adding an app automatically allows it.
		const allowedOrigins = new Set([
			'tauri://localhost',
			...Object.values(APPS).flatMap((a) => [a.url, `http://localhost:${a.port}`]),
		]);
		app.use('*', async (c, next) => {
			if (c.req.header('upgrade') === 'websocket') return next();
			return cors({
				origin: (origin) => {
					if (!origin) return origin;
					if (allowedOrigins.has(origin)) return origin;
					if (origin.startsWith('chrome-extension://')) return origin;
					return undefined;
				},
				credentials: true,
				allowHeaders: ['Content-Type', 'Authorization', 'Upgrade'],
				allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
			})(c, next);
		});

		// Layer 1: Database — per-request pg.Client lifecycle (connect/end).
		// Uses Client (not Pool) because Hyperdrive IS the connection pool.
		app.use('*', async (c, next) => {
			// 1. Create a fresh pg connection and afterResponse queue for this request.
			const client = new pg.Client({
				connectionString: c.env.HYPERDRIVE.connectionString,
			});
			const afterResponse = createAfterResponseQueue();
			try {
				// 2. Connect and expose db + queue to downstream handlers.
				await client.connect();
				c.set('db', drizzle(client, { schema }));
				c.set('afterResponse', afterResponse);

				// 3. Run the route handler. Handlers push fire-and-forget
				//    promises (e.g. upsertDoInstance) into afterResponse.
				await next();
			} finally {
				// 4. The response has already left — Hono streams it during `await next()`.
				//    But the fire-and-forget promises are still in-flight. CF Workers
				//    would kill the isolate as soon as the response finishes, so we use
				//    `waitUntil()` to keep it alive. `drain()` settles every queued
				//    promise via `Promise.allSettled`, then `.then()` closes the pg
				//    connection — guaranteeing the client outlives all its queries.
				c.executionCtx.waitUntil(
					afterResponse.drain().then(() => client.end()),
				);
			}
		});

		// Layer 2: Auth — pure, reads db from context.
		app.use('*', async (c, next) => {
			c.set('auth', createAuth({ db: c.var.db, env: c.env, baseURL: new URL(c.req.url).origin }));
			await next();
		});
	},
});

const app = factory.createApp();

// Health
app.get(
	'/',
	describeRoute({
		description: 'Health check',
		tags: ['health'],
	}),
	(c) => c.json({ mode: 'hub', version: '0.1.0', runtime: 'cloudflare' }),
);

// Auth pages — server-rendered Hono JSX
app.get('/sign-in', async (c) => {
	const session = await c.var.auth.api.getSession({
		headers: c.req.raw.headers,
	});
	if (session) {
		const url = new URL(c.req.url);
		// OAuth re-entry: signed params present → continue the authorize flow
		if (url.searchParams.has('sig')) {
			return c.redirect(`/auth/oauth2/authorize${url.search}`);
		}
		// Post-signin redirect (e.g. from /device or /consent)
		const callbackURL = url.searchParams.get('callbackURL');
		if (callbackURL?.startsWith('/')) {
			return c.redirect(callbackURL);
		}
		// Already signed in, no redirect needed — show signed-in confirmation
		const displayName = session.user.name ?? session.user.email;
		return c.html(
			renderSignedInPage({ displayName, email: session.user.email }),
		);
	}
	return c.html(renderSignInPage());
});
app.get(
	'/consent',
	sValidator('query', type({ 'client_id?': 'string', 'scope?': 'string' })),
	async (c) => {
		const session = await c.var.auth.api.getSession({
			headers: c.req.raw.headers,
		});
		if (!session) {
			const consentUrl = `/consent${new URL(c.req.url).search}`;
			return c.redirect(
				`/sign-in?callbackURL=${encodeURIComponent(consentUrl)}`,
			);
		}
		const { client_id: clientId, scope } = c.req.valid('query');
		return c.html(renderConsentPage({ clientId, scope }));
	},
);
app.get(
	'/device',
	sValidator('query', type({ 'user_code?': 'string' })),
	async (c) => {
		const { user_code: userCode } = c.req.valid('query');
		const session = await c.var.auth.api.getSession({
			headers: c.req.raw.headers,
		});
		if (!session) {
			const callbackURL = userCode
				? `/device?user_code=${encodeURIComponent(userCode)}`
				: '/device';
			return c.redirect(
				`/sign-in?callbackURL=${encodeURIComponent(callbackURL)}`,
			);
		}
		return c.html(renderDevicePage({ userCode }));
	},
);

// Auth
app.on(
	['GET', 'POST'],
	'/auth/*',
	describeRoute({
		description: 'Better Auth handler',
		tags: ['auth'],
	}),
	(c) => c.var.auth.handler(c.req.raw),
);

// OAuth discovery
app.get(
	'/.well-known/openid-configuration/auth',
	describeRoute({
		description: 'OpenID Connect discovery metadata',
		tags: ['auth', 'oauth'],
	}),
	(c) => oauthProviderOpenIdConfigMetadata(c.var.auth)(c.req.raw),
);
app.get(
	'/.well-known/oauth-authorization-server/auth',
	describeRoute({
		description: 'OAuth authorization server metadata',
		tags: ['auth', 'oauth'],
	}),
	(c) => oauthProviderAuthServerMetadata(c.var.auth)(c.req.raw),
);

// Auth guard for protected routes
const authGuard = factory.createMiddleware(async (c, next) => {
	const wsToken = c.req.query('token');
	const headers = wsToken
		? new Headers({ authorization: `Bearer ${wsToken}` })
		: c.req.raw.headers;

	const result = await c.var.auth.api.getSession({ headers });
	if (!result) return c.json({ error: 'Unauthorized' }, 401);

	c.set('user', result.user);
	c.set('session', result.session);
	await next();
});
app.use('/ai/*', authGuard);
// Ensure authenticated AI users exist as Autumn customers (blocking—must
// complete before downstream check() calls, which require the customer to exist).
app.use('/ai/*', async (c, next) => {
	const autumn = createAutumn(c.env);
	await autumn.customers.getOrCreate({
		customerId: c.var.user.id,
		name: c.var.user.name ?? undefined,
		email: c.var.user.email ?? undefined,
	});
	await next();
});
app.use('/workspaces/*', authGuard);
app.use('/documents/*', authGuard);
app.use('/billing', authGuard);
app.use('/billing/*', authGuard);

// Billing — server-rendered Hono JSX billing page
app.route('/billing', billing);

// AI chat
app.post(
	'/ai/chat',
	describeRoute({
		description: 'Stream AI chat completions via SSE',
		tags: ['ai'],
	}),
	...aiChatHandlers,
);

// ---------------------------------------------------------------------------
// Workspace routes — one WorkspaceRoom DO per workspace (gc: true)
// ---------------------------------------------------------------------------

/**
 * DO name namespacing: `user:{userId}:{type}:{name}`
 *
 * We use user-scoped DO names (Google Docs model) rather than org-scoped names
 * (Vercel/Supabase model). Each user gets their own DO instance per workspace.
 *
 * Alternatives considered:
 *
 * - **Org-scoped (`org:{orgId}:{name}`)**: Evaluated for enterprise/self-hosted.
 *   Problems: most workspaces (Whispering recordings, Entries) are personal data
 *   that shouldn't merge into a shared Y.Doc. Org-scoped would require a
 *   per-workspace `scope` flag anyway, adding complexity without simplifying.
 *
 * - **Org-scoped with personal sub-scope (`org:{orgId}:user:{userId}:{name}`)**:
 *   Embeds org management in the app. For self-hosted enterprise, the deployment
 *   itself IS the org boundary (like GitLab, Outline, Mattermost), so org tables
 *   and Better Auth organization plugin are unnecessary overhead.
 *
 * Current scheme keeps the app auth-simple ("user has account, user accesses
 * their data") and works for both cloud and self-hosted without org infrastructure.
 * When sharing is needed, it follows the Google Docs pattern: the owner's DO
 * name stays the same, an ACL table grants access to other users, and auth
 * middleware checks "is this user the owner OR in the ACL?"
 *
 * Multi-tenant cloud isolation (if needed later) is a platform-layer concern—
 * a tenant prefix added at the routing layer, not embedded in the app's data model.
 */

/** Get a WorkspaceRoom DO stub and its DO name for the authenticated user's workspace. */
function getWorkspaceStub(c: Context<Env>) {
	const doName = `user:${c.var.user.id}:workspace:${c.req.param('workspace')}`;
	return {
		stub: c.env.WORKSPACE_ROOM.get(c.env.WORKSPACE_ROOM.idFromName(doName)),
		doName,
	};
}

/** Get a DocumentRoom DO stub and its DO name for the authenticated user's document. */
function getDocumentStub(c: Context<Env>) {
	const doName = `user:${c.var.user.id}:document:${c.req.param('document')}`;
	return {
		stub: c.env.DOCUMENT_ROOM.get(c.env.DOCUMENT_ROOM.idFromName(doName)),
		doName,
	};
}

/**
 * Fire-and-forget upsert for DO instance tracking.
 *
 * Records that a user accessed a DO, optionally updating storage bytes.
 * Uses INSERT ON CONFLICT so the first access creates the row and
 * subsequent accesses update `lastAccessedAt` (and `storageBytes` when
 * provided). Errors are caught and logged—this is best-effort telemetry,
 * not billing authority.
 */
function upsertDoInstance(
	db: Db,
	params: {
		userId: string;
		doType: schema.DoType;
		resourceName: string;
		doName: string;
		storageBytes?: number;
	},
) {
	const now = new Date();
	return db
		.insert(schema.durableObjectInstance)
		.values({
			userId: params.userId,
			doType: params.doType,
			resourceName: params.resourceName,
			doName: params.doName,
			storageBytes: params.storageBytes ?? null,
			lastAccessedAt: now,
			storageMeasuredAt: params.storageBytes != null ? now : null,
		})
		.onConflictDoUpdate({
			target: schema.durableObjectInstance.doName,
			set: {
				lastAccessedAt: now,
				...(params.storageBytes != null && {
					storageBytes: params.storageBytes,
					storageMeasuredAt: now,
				}),
			},
		})
		.catch((e) => console.error('[do-tracking] upsert failed:', e));
}

app.get(
	'/workspaces/:workspace',
	describeRoute({
		description: 'Get workspace doc or upgrade to WebSocket',
		tags: ['workspaces'],
	}),
	async (c) => {
		const { stub, doName } = getWorkspaceStub(c);

		if (c.req.header('upgrade') === 'websocket') {
			c.var.afterResponse.push(
				upsertDoInstance(c.var.db, {
					userId: c.var.user.id,
					doType: 'workspace',
					resourceName: c.req.param('workspace'),
					doName,
				}),
			);
			return stub.fetch(c.req.raw);
		}

		const { data, storageBytes } = await stub.getDoc();
		c.var.afterResponse.push(
			upsertDoInstance(c.var.db, {
				userId: c.var.user.id,
				doType: 'workspace',
				resourceName: c.req.param('workspace'),
				doName,
				storageBytes,
			}),
		);
		return new Response(data, {
			headers: { 'content-type': 'application/octet-stream' },
		});
	},
);

app.post(
	'/workspaces/:workspace',
	describeRoute({
		description: 'Sync workspace doc',
		tags: ['workspaces'],
	}),
	async (c) => {
		const body = new Uint8Array(await c.req.arrayBuffer());
		if (body.byteLength > MAX_PAYLOAD_BYTES) {
			return c.body('Payload too large', 413);
		}

		const { stub, doName } = getWorkspaceStub(c);
		const { diff, storageBytes } = await stub.sync(body);

		c.var.afterResponse.push(
			upsertDoInstance(c.var.db, {
				userId: c.var.user.id,
				doType: 'workspace',
				resourceName: c.req.param('workspace'),
				doName,
				storageBytes,
			}),
		);

		if (!diff) return c.body(null, 304);
		return new Response(diff, {
			headers: { 'content-type': 'application/octet-stream' },
		});
	},
);

// ---------------------------------------------------------------------------
// Document routes — one DocumentRoom DO per document (gc: false, snapshots)
// ---------------------------------------------------------------------------

app.get(
	'/documents/:document',
	describeRoute({
		description: 'Get document doc or upgrade to WebSocket',
		tags: ['documents'],
	}),
	async (c) => {
		const { stub, doName } = getDocumentStub(c);

		if (c.req.header('upgrade') === 'websocket') {
			c.var.afterResponse.push(
				upsertDoInstance(c.var.db, {
					userId: c.var.user.id,
					doType: 'document',
					resourceName: c.req.param('document'),
					doName,
				}),
			);
			return stub.fetch(c.req.raw);
		}

		const { data, storageBytes } = await stub.getDoc();
		c.var.afterResponse.push(
			upsertDoInstance(c.var.db, {
				userId: c.var.user.id,
				doType: 'document',
				resourceName: c.req.param('document'),
				doName,
				storageBytes,
			}),
		);
		return new Response(data, {
			headers: { 'content-type': 'application/octet-stream' },
		});
	},
);

app.post(
	'/documents/:document',
	describeRoute({
		description: 'Sync document doc',
		tags: ['documents'],
	}),
	async (c) => {
		const body = new Uint8Array(await c.req.arrayBuffer());
		if (body.byteLength > MAX_PAYLOAD_BYTES) {
			return c.body('Payload too large', 413);
		}

		const { stub, doName } = getDocumentStub(c);
		const { diff, storageBytes } = await stub.sync(body);

		c.var.afterResponse.push(
			upsertDoInstance(c.var.db, {
				userId: c.var.user.id,
				doType: 'document',
				resourceName: c.req.param('document'),
				doName,
				storageBytes,
			}),
		);

		if (!diff) return c.body(null, 304);
		return new Response(diff, {
			headers: { 'content-type': 'application/octet-stream' },
		});
	},
);

// Snapshot endpoints for DocumentRoom
app.post(
	'/documents/:document/snapshots',
	describeRoute({
		description: 'Save a document snapshot',
		tags: ['documents', 'snapshots'],
	}),
	sValidator('json', type({ label: 'string | null' })),
	async (c) => {
		const { stub } = getDocumentStub(c);
		const { label } = c.req.valid('json');
		const result = await stub.saveSnapshot(label ?? undefined);
		return c.json(result);
	},
);

app.get(
	'/documents/:document/snapshots',
	describeRoute({
		description: 'List document snapshots',
		tags: ['documents', 'snapshots'],
	}),
	async (c) => {
		const { stub } = getDocumentStub(c);
		const snapshots = await stub.listSnapshots();
		return c.json(snapshots);
	},
);

app.get(
	'/documents/:document/snapshots/:id',
	describeRoute({
		description: 'Get a document snapshot by ID',
		tags: ['documents', 'snapshots'],
	}),
	sValidator('param', type({ document: 'string', id: 'string.numeric' })),
	async (c) => {
		const { stub } = getDocumentStub(c);
		const { id } = c.req.valid('param');
		const data = await stub.getSnapshot(Number(id));
		if (!data) return c.body('Snapshot not found', 404);
		return new Response(data, {
			headers: { 'content-type': 'application/octet-stream' },
		});
	},
);

app.delete(
	'/documents/:document/snapshots/:id',
	describeRoute({
		description: 'Delete a document snapshot',
		tags: ['documents', 'snapshots'],
	}),
	sValidator('param', type({ document: 'string', id: 'string.numeric' })),
	async (c) => {
		const stub = getDocumentStub(c);
		const { id } = c.req.valid('param');
		const deleted = await stub.deleteSnapshot(Number(id));
		if (!deleted) return c.body('Snapshot not found', 404);
		return c.body(null, 204);
	},
);

export default app;
