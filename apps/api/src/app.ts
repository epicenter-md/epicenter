import {
	oauthProvider,
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import { jwt } from 'better-auth/plugins/jwt';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { createFactory } from 'hono/factory';
import { describeRoute } from 'hono-openapi';
import pg from 'pg';
import { aiChatHandlers } from './ai-chat';
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
};

/** Creates a Better Auth instance using an already-connected Drizzle instance. */
function createAuth(db: Db, env: Env['Bindings']) {
	return betterAuth({
		...BASE_AUTH_CONFIG,
		database: drizzleAdapter(db, { provider: 'pg' }),
		baseURL: env.BASE_URL,
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
				'https://*.epicenter.so',
				'https://epicenter.so',
				'tauri://localhost',
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
		// CORS — skip WebSocket upgrades (101 response headers are immutable)
		app.use('*', async (c, next) => {
			if (c.req.header('upgrade') === 'websocket') return next();
			return cors({
				origin: (origin) => {
					if (!origin) return origin;
					if (origin === 'https://epicenter.so') return origin;
					if (origin.endsWith('.epicenter.so') && origin.startsWith('https://'))
						return origin;
					if (origin === 'tauri://localhost') return origin;
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
				c.executionCtx.waitUntil(afterResponse.drain().then(() => client.end()));
			}
		});

		// Layer 2: Auth — pure, reads db from context.
		app.use('*', async (c, next) => {
			c.set('auth', createAuth(c.var.db, c.env));
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
app.use('/workspaces/*', authGuard);
app.use('/documents/*', authGuard);

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

app.post(
	'/documents/:document/snapshots/:id/apply',
	describeRoute({
		description:
			'Apply a past snapshot state into the current document (CRDT forward-merge)',
		tags: ['documents', 'snapshots'],
	}),
	sValidator('param', type({ document: 'string', id: 'string.numeric' })),
	async (c) => {
		const { stub } = getDocumentStub(c);
		const { id } = c.req.valid('param');
		const ok = await stub.applySnapshot(Number(id));
		if (!ok) return c.json({ error: 'Snapshot not found' }, 404);
		return c.body(null, 204);
	},
);

export default app;
