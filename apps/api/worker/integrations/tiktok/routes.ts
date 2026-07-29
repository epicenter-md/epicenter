/**
 * Hosted TikTok publishing surface: `/api/integrations/tiktok/*`.
 *
 * These routes connect a TikTok CREATOR account, post one video to it, follow
 * that post to its outcome, and disconnect the account. Direct Post is the only
 * publishing product: there is no inbox-draft path and no read-back of the
 * creator's other posts (see TIKTOK_SCOPES in config.ts).
 *
 * They are not, and must never become, a way to sign in to Epicenter. Better
 * Auth remains the only login system; nothing here writes the `user`, `session`,
 * or `account` tables. See `db/schema/integrations.ts` for why TikTok is
 * deliberately absent from `socialProviders`.
 *
 * Authentication is COOKIE-ONLY on every route. The integration is a dashboard
 * capability, so a leaked OAuth bearer cannot publish to a creator's TikTok or
 * revoke their grant. Upgrade trigger: if an agent or CLI ever needs to publish,
 * add a deliberately scoped bearer path then, rather than leaving one open now.
 *
 * The two routes that change WHICH accounts are authorized (connect, disconnect)
 * additionally demand a FRESH session, mirroring the bar `base-config.ts` holds
 * login-method changes to. Granting a background service the ability to post as
 * a creator deserves the same proof-of-human as adding a login method, and the
 * dashboard already knows the `SESSION_NOT_FRESH` remedy.
 *
 * Lives in apps/api, not @epicenter/server: connected publishing accounts are
 * hosted product policy. The self-hosted single-partition instance has no
 * per-user account substrate to hang a grant on and never mounts this.
 */

import type { CloudEnv } from '@epicenter/server';
import type { Db } from '@epicenter/server/cloud-db';
import type { Hono, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { describeRoute } from 'hono-openapi';
import { nanoid } from 'nanoid';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import {
	createTikTokApi,
	isAmbiguousFailure,
	MAX_SINGLE_CHUNK_BYTES,
	privacyLevels,
	type TikTokPrivacyLevel,
} from './api.js';
import {
	resolveTikTokConfig,
	TIKTOK_SCOPES,
	type TikTokBindings,
	tiktokRedirectUri,
} from './config.js';
import { validateDirectPost } from './direct-post-policy.js';
import { readMp4DurationSec } from './mp4-duration.js';
import {
	buildAuthorizeUrl,
	createOAuthStateValue,
	createTikTokOAuthClient,
} from './oauth.js';
import {
	isValidIdempotencyKey,
	MAX_IDEMPOTENCY_KEY_LENGTH,
	MIN_IDEMPOTENCY_KEY_LENGTH,
} from './publish-intent.js';
import {
	claimPublishAttempt,
	consumeOAuthState,
	createOAuthState,
	deleteConnection,
	deleteExpiredOAuthStates,
	listConnections,
	listPublishAttempts,
	readConnection,
	reconcileAttemptFromRemote,
	recordAttemptOutcome,
	toPublicConnection,
	upsertConnection,
} from './store.js';
import { ensureAccessToken } from './tokens.js';

/**
 * Better Auth's `session.freshAge` default, mirrored here exactly as the
 * account-deletion route does. The deployment does not override it.
 */
const FRESH_AGE_SECONDS = 60 * 60 * 24;

/** How long a creator has to finish the TikTok consent screen. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Where the dashboard's TikTok surface lives, and the only default return. */
const DEFAULT_RETURN_PATH = '/dashboard/integrations';

/**
 * The one scope every publishing call needs. A creator can decline it on
 * TikTok's consent screen, leaving a real connection that cannot publish, so
 * every route that touches TikTok checks the GRANTED set rather than assuming
 * the requested one.
 */
const DIRECT_POST_SCOPE = 'video.publish';

const TikTokRouteError = defineErrors({
	Unauthorized: () => ({ message: 'Session required' }),
	SessionNotFresh: () => ({
		message: 'Sign in again to change your connected TikTok accounts.',
		code: 'SESSION_NOT_FRESH',
	}),
	ConnectionNotFound: () => ({ message: 'No such TikTok connection.' }),
	InvalidRequest: ({ detail }: { detail: string }) => ({
		message: detail,
		detail,
	}),
	/**
	 * A requested post setting the connected account may not currently choose.
	 * Refused SERVER-side against a live `creator_info/query`, so a stale or
	 * tampered form cannot post under settings TikTok would reject or, worse,
	 * silently reinterpret.
	 */
	CreatorSettingRefused: ({
		detail,
		field,
	}: {
		detail: string;
		/** Which control to point the creator at; see DirectPostViolation. */
		field?: string;
	}) => ({
		message: detail,
		detail,
		field,
	}),
	/** The connection lacks a scope this operation needs (a partial grant). */
	ScopeNotGranted: ({ scope }: { scope: string }) => ({
		message: `This TikTok account did not grant the "${scope}" permission. Reconnect it and approve that permission to use this.`,
		scope,
	}),
	/**
	 * The outcome of an irreversible publish is UNKNOWN. TikTok may have created
	 * the task; we cannot see the answer. Never retried automatically: the remedy
	 * is to read the attempt's status, and re-submitting the same intent collides
	 * with the claim that is already recorded.
	 */
	PublishOutcomeUnknown: ({
		attemptId,
		publishId,
		detail,
	}: {
		attemptId: string;
		publishId: string | null;
		detail: string;
	}) => ({
		message: `TikTok may have accepted this post, but Epicenter could not confirm it (${detail}). Check the attempt's status before trying again; do not re-submit.`,
		attemptId,
		publishId,
		detail,
		/** The client uses this to refuse an automatic retry. */
		unresolved: true,
	}),
	/**
	 * This idempotency key already claimed a publish. TikTok's `video/init` is
	 * irreversible, so the second caller is told to READ the first attempt's
	 * status rather than being allowed to originate another post.
	 */
	PublishAlreadyAttempted: ({
		attemptId,
		publishId,
		status,
	}: {
		attemptId: string;
		publishId: string | null;
		status: string | null;
	}) => ({
		message:
			'This publish was already attempted. Read its status rather than submitting again.',
		attemptId,
		publishId,
		status,
	}),
});

type SessionUser = { id: string; email?: string | null };

/**
 * Cookie session, with the cookie cache bypassed so every integration route
 * observes the live session row rather than a up-to-5-minute-old snapshot.
 */
function cookieSession(options: {
	fresh: boolean;
}): MiddlewareHandler<CloudEnv & { Variables: { tiktokUser: SessionUser } }> {
	return createMiddleware(async (c, next) => {
		const session = await c.var.auth.api.getSession({
			headers: c.req.raw.headers,
			query: { disableCookieCache: true },
		});
		if (!session) return c.json(TikTokRouteError.Unauthorized(), 401);
		if (options.fresh) {
			const createdAt = new Date(session.session.createdAt).getTime();
			if (Date.now() - createdAt >= FRESH_AGE_SECONDS * 1000) {
				return c.json(TikTokRouteError.SessionNotFresh(), 403);
			}
		}
		c.set('tiktokUser', session.user as SessionUser);
		return next();
	});
}

/** Only same-origin dashboard paths are acceptable returns after the ceremony. */
function safeReturnPath(candidate: unknown): string {
	return typeof candidate === 'string' &&
		candidate.startsWith('/') &&
		!candidate.startsWith('//')
		? candidate
		: DEFAULT_RETURN_PATH;
}

function readBoolean(value: unknown): boolean {
	return value === true || value === 'true' || value === 'on' || value === '1';
}

type TikTokEnv = CloudEnv & { Variables: { tiktokUser: SessionUser } };

export function mountTikTokIntegrationApi(app: Hono<CloudEnv>): void {
	const tiktok = app as unknown as Hono<TikTokEnv>;
	const session = cookieSession({ fresh: false });
	const freshSession = cookieSession({ fresh: true });

	/**
	 * Resolve config, or answer the named 503 once. Every route funnels through
	 * this so an unconfigured deployment fails the same recognizable way instead
	 * of each handler inventing its own half-working path.
	 */
	async function withConfig<T>(
		c: Parameters<MiddlewareHandler<TikTokEnv>>[0],
		use: (config: {
			clientKey: string;
			clientSecret: string;
			cipher: import('./token-cipher.js').TokenCipher;
		}) => Promise<T>,
	): Promise<T | Response> {
		// The whole Result is forwarded, not rebuilt: it is already the wellcrafted
		// `{ data: null, error: { name, message, ...fields } }` envelope every
		// non-2xx response in this deployment answers with.
		const configured = await resolveTikTokConfig(
			c.env as unknown as TikTokBindings,
		);
		if (configured.error) return c.json(configured, 503);
		return use(configured.data);
	}

	// --- Connect -----------------------------------------------------------

	tiktok.post(
		'/api/integrations/tiktok/connect',
		describeRoute({
			description:
				'Begin authorizing a TikTok creator account for publishing. Returns the TikTok consent URL. Requires a fresh session.',
			tags: ['integrations', 'tiktok'],
		}),
		freshSession,
		async (c) =>
			withConfig(c, async (config) => {
				const body = await c.req.json().catch(() => ({}));
				const returnPath = safeReturnPath(
					(body as Record<string, unknown>).returnPath,
				);

				const state = createOAuthStateValue();
				const db = c.var.db as Db;

				await createOAuthState(db, {
					state,
					userId: c.var.tiktokUser.id,
					returnPath,
					expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
				});
				// Opportunistic housekeeping; a failure here must not block a connect.
				await deleteExpiredOAuthStates(db, new Date()).catch(() => {});

				return c.json({
					url: buildAuthorizeUrl({
						clientKey: config.clientKey,
						redirectUri: tiktokRedirectUri(c.var.authBaseURL),
						scopes: TIKTOK_SCOPES,
						state,
						// A creator connecting a SECOND account must not be silently
						// re-authorized back into the first one, so always show consent.
						disableAutoAuth: true,
					}),
				});
			}),
	);

	/**
	 * TikTok's redirect lands here as a top-level GET navigation carrying the
	 * session cookie (the `/api/*` CSRF gate guards cookie MUTATIONS and exempts
	 * GET, so this passes without widening anything).
	 *
	 * Every failure redirects back to the dashboard with a readable `?error=`
	 * rather than rendering JSON at the creator, because this URL is reached by
	 * a human's browser, not by client code.
	 */
	tiktok.get(
		'/api/integrations/tiktok/callback',
		describeRoute({
			description: 'TikTok Login Kit OAuth callback.',
			tags: ['integrations', 'tiktok'],
		}),
		async (c) => {
			const back = (path: string, params: Record<string, string>) => {
				const url = new URL(path, c.var.authBaseURL);
				for (const [key, value] of Object.entries(params)) {
					url.searchParams.set(key, value);
				}
				return c.redirect(url.pathname + url.search);
			};

			const query = c.req.query();
			const db = c.var.db as Db;

			// SESSION FIRST. Nothing is consumed, exchanged, or attached without a
			// live session, so an unauthenticated hit on this URL cannot touch any
			// stored state at all.
			const current = await c.var.auth.api.getSession({
				headers: c.req.raw.headers,
				query: { disableCookieCache: true },
			});
			if (!current) {
				return back(DEFAULT_RETURN_PATH, {
					error:
						'Sign in to Epicenter first, then connect the TikTok account again.',
				});
			}

			// Consume the state EXACTLY ONCE, scoped to the signed-in user. Both
			// halves matter: `DELETE ... RETURNING` is read and invalidation in one
			// statement, and the `user_id` predicate means a leaked state replayed by
			// a DIFFERENT signed-in user matches nothing, so it cannot cancel the
			// real user's in-flight ceremony. This runs before the denial and
			// malformed-link branches so no outcome leaves a replayable row behind.
			const stateValue = query.state;
			const stored = stateValue
				? await consumeOAuthState(db, {
						state: stateValue,
						userId: current.user.id,
					})
				: null;

			// The creator declined, or TikTok refused.
			if (query.error) {
				return back(stored?.returnPath ?? DEFAULT_RETURN_PATH, {
					error:
						query.error_description ||
						'TikTok did not authorize that account. Nothing was connected.',
				});
			}

			if (!stateValue || !query.code) {
				return back(stored?.returnPath ?? DEFAULT_RETURN_PATH, {
					error:
						'That TikTok authorization link was incomplete. Try connecting again.',
				});
			}
			// No row for (this state, this user): already used, expired, forged, or
			// started by a different Epicenter account. All four are the same answer,
			// and none of them attach anything.
			if (!stored) {
				return back(DEFAULT_RETURN_PATH, {
					error:
						'That TikTok authorization link was already used, has expired, or was started by a different Epicenter account. Try connecting again.',
				});
			}
			if (stored.expiresAt.getTime() <= Date.now()) {
				return back(stored.returnPath, {
					error:
						'That TikTok authorization took too long. Try connecting again.',
				});
			}

			const configured = await resolveTikTokConfig(
				c.env as unknown as TikTokBindings,
			);
			if (configured.error) {
				return back(stored.returnPath, {
					error: 'TikTok publishing is not configured on this deployment.',
				});
			}
			const { clientKey, clientSecret, cipher } = configured.data;
			const oauth = createTikTokOAuthClient({ clientKey, clientSecret });

			const { data: grant, error: exchangeError } = await oauth.exchangeCode({
				code: query.code,
				redirectUri: tiktokRedirectUri(c.var.authBaseURL),
			});
			if (exchangeError) {
				return back(stored.returnPath, { error: exchangeError.message });
			}

			// Read the identity with the token we just received, so the row names the
			// account that was actually authorized rather than one the caller claimed.
			const { data: userInfo, error: userInfoError } = await createTikTokApi({
				accessToken: grant.accessToken,
			}).readUserInfo();
			if (userInfoError) {
				return back(stored.returnPath, { error: userInfoError.message });
			}

			const accessCiphertext = await cipher.encrypt(grant.accessToken);
			if (accessCiphertext.error) {
				return back(stored.returnPath, {
					error: accessCiphertext.error.message,
				});
			}
			const refreshCiphertext = await cipher.encrypt(grant.refreshToken);
			if (refreshCiphertext.error) {
				return back(stored.returnPath, {
					error: refreshCiphertext.error.message,
				});
			}

			const now = Date.now();
			const connection = await upsertConnection(db, {
				id: nanoid(),
				userId: stored.userId,
				openId: userInfo.openId,
				unionId: userInfo.unionId,
				displayName: userInfo.displayName,
				username: userInfo.username,
				avatarUrl: userInfo.avatarUrl,
				// The GRANTED scopes, which the consent screen may have narrowed.
				scopes: [...grant.scopes],
				accessTokenCiphertext: accessCiphertext.data,
				accessTokenExpiresAt: new Date(now + grant.expiresInSec * 1000),
				refreshTokenCiphertext: refreshCiphertext.data,
				refreshTokenExpiresAt: new Date(now + grant.refreshExpiresInSec * 1000),
			});

			return back(stored.returnPath, { connected: connection.id });
		},
	);

	// --- Read / disconnect --------------------------------------------------

	tiktok.get(
		'/api/integrations/tiktok/connections',
		describeRoute({
			description:
				'List the TikTok accounts this user has connected, with the scopes each actually granted. Never includes tokens.',
			tags: ['integrations', 'tiktok'],
		}),
		session,
		async (c) => {
			const rows = await listConnections(c.var.db as Db, c.var.tiktokUser.id);
			const { data: config } = await resolveTikTokConfig(
				c.env as unknown as TikTokBindings,
			);
			return c.json({
				configured: config !== null,
				// The exact string that must be registered in the TikTok developer
				// portal for THIS deployment, so the portal value is read off a live
				// route instead of being retyped from memory. Shown only in the
				// unconfigured-deployment state, which is an operator problem rather
				// than part of the creator's product.
				redirectUri: tiktokRedirectUri(c.var.authBaseURL),
				connections: rows.map(toPublicConnection),
			});
		},
	);

	tiktok.delete(
		'/api/integrations/tiktok/connections/:id',
		describeRoute({
			description:
				'Disconnect a TikTok account: revoke the grant at TikTok, then delete the local tokens. Requires a fresh session.',
			tags: ['integrations', 'tiktok'],
		}),
		freshSession,
		async (c) =>
			withConfig(c, async (config) => {
				const db = c.var.db as Db;
				const connectionId = c.req.param('id');
				const row = await readConnection(db, {
					userId: c.var.tiktokUser.id,
					connectionId,
				});
				if (!row) return c.json(TikTokRouteError.ConnectionNotFound(), 404);

				const oauth = createTikTokOAuthClient({
					clientKey: config.clientKey,
					clientSecret: config.clientSecret,
				});

				/**
				 * Revocation at TikTok and deletion here are DIFFERENT facts, and the
				 * response reports both rather than collapsing them into "done".
				 * Local rows are always deleted: keeping a token we were asked to
				 * forget would be worse than a stale grant on TikTok's side, which the
				 * creator can also revoke from TikTok's own settings.
				 */
				let revokedAtProvider = false;
				let revokeFailure: string | null = null;
				const access = await ensureAccessToken({
					db,
					cipher: config.cipher,
					oauth,
					connectionId,
				});
				if (access.error) {
					revokeFailure = access.error.message;
				} else {
					const { error } = await oauth.revoke(access.data.accessToken);
					if (error) revokeFailure = error.message;
					else revokedAtProvider = true;
				}

				const deleted = await deleteConnection(db, {
					userId: c.var.tiktokUser.id,
					connectionId,
				});

				return c.json({
					deletedLocally: deleted,
					revokedAtProvider,
					// Present only when TikTok could not be told. The creator is shown
					// this verbatim so "disconnected here" is never misread as
					// "revoked at TikTok".
					revokeFailure,
				});
			}),
	);

	// --- Post to TikTok ------------------------------------------------------

	/**
	 * Resolve a connection plus a live access token, or the right HTTP failure.
	 * Every publishing route below starts here.
	 *
	 * The scope gate is a constant rather than a parameter, because there is one
	 * publishing product and all three of its calls (`creator_info/query`,
	 * `video/init`, `status/fetch`) are reachable with exactly `video.publish`.
	 * A partial grant is refused with that scope NAMED, so the creator gets an
	 * instruction instead of TikTok's generic permission error.
	 */
	async function openConnection(
		c: Parameters<MiddlewareHandler<TikTokEnv>>[0],
		config: {
			clientKey: string;
			clientSecret: string;
			cipher: import('./token-cipher.js').TokenCipher;
		},
	) {
		const db = c.var.db as Db;
		// This helper is shared across routes, so the param is not narrowed by a
		// literal path here. An absent id reads as "not found", the same answer a
		// wrong id gets.
		const connectionId = c.req.param('id') ?? '';
		const row = await readConnection(db, {
			userId: c.var.tiktokUser.id,
			connectionId,
		});
		if (!row) {
			return {
				failure: c.json(TikTokRouteError.ConnectionNotFound(), 404),
			} as const;
		}
		if (!row.scopes.includes(DIRECT_POST_SCOPE)) {
			return {
				failure: c.json(
					TikTokRouteError.ScopeNotGranted({ scope: DIRECT_POST_SCOPE }),
					403,
				),
			} as const;
		}
		const oauth = createTikTokOAuthClient({
			clientKey: config.clientKey,
			clientSecret: config.clientSecret,
		});
		const access = await ensureAccessToken({
			db,
			cipher: config.cipher,
			oauth,
			connectionId,
		});
		if (access.error) {
			return { failure: c.json(access, 502) } as const;
		}
		return {
			row,
			db,
			api: createTikTokApi({ accessToken: access.data.accessToken }),
		} as const;
	}

	tiktok.get(
		'/api/integrations/tiktok/connections/:id/creator-info',
		describeRoute({
			description:
				"Read the connected account's current posting options. TikTok requires this before any posting surface is shown.",
			tags: ['integrations', 'tiktok'],
		}),
		session,
		async (c) =>
			withConfig(c, async (config) => {
				const opened = await openConnection(c, config);
				if ('failure' in opened) return opened.failure;
				const creatorInfo = await opened.api.readCreatorInfo();
				if (creatorInfo.error) return c.json(creatorInfo, 502);
				return c.json(creatorInfo.data);
			}),
	);

	tiktok.get(
		'/api/integrations/tiktok/connections/:id/attempts',
		describeRoute({
			description: 'Recent publish attempts for this connection.',
			tags: ['integrations', 'tiktok'],
		}),
		session,
		async (c) => {
			const db = c.var.db as Db;
			const row = await readConnection(db, {
				userId: c.var.tiktokUser.id,
				connectionId: c.req.param('id'),
			});
			if (!row) return c.json(TikTokRouteError.ConnectionNotFound(), 404);
			return c.json({ attempts: await listPublishAttempts(db, row.id) });
		},
	);

	/**
	 * Read remote truth for one publishing task, and RECONCILE the durable
	 * attempt row against it. This is how an ambiguous publish is resolved; never
	 * by retrying it.
	 *
	 * The read and the write are one route on purpose. TikTok owns the outcome and
	 * only tells us when asked, so the moment we ask is the only moment the stored
	 * row can be corrected. Splitting them would leave the obvious failure this
	 * subsystem had before: an attempt row frozen at `PROCESSING_UPLOAD` long
	 * after TikTok finished, because the surface that learned the truth had no
	 * business writing it down.
	 *
	 * A GET that writes is deliberate and safe here: every value written is
	 * TikTok's own answer, so the write is idempotent, carries no caller input,
	 * and re-reading a settled task changes nothing.
	 */
	tiktok.get(
		'/api/integrations/tiktok/connections/:id/publish/:publishId',
		describeRoute({
			description:
				"Read TikTok's status for one publishing task and reconcile the recorded attempt against it. This is how an ambiguous publish is resolved; never by retrying it.",
			tags: ['integrations', 'tiktok'],
		}),
		session,
		async (c) =>
			withConfig(c, async (config) => {
				const opened = await openConnection(c, config);
				if ('failure' in opened) return opened.failure;
				const publishId = c.req.param('publishId');
				const status = await opened.api.readPostStatus(publishId);
				if (status.error) return c.json(status, 502);

				// Best-effort: TikTok's answer is the valuable part and is returned
				// either way. A failed reconcile leaves the row stale, which the next
				// read corrects, and is never a reason to withhold the outcome.
				const recorded = await reconcileAttemptFromRemote(opened.db, {
					connectionId: opened.row.id,
					publishId,
					status: status.data.code,
					publicPostIds: status.data.publicPostIds,
					failReason: status.data.failReason ?? null,
				}).catch(() => false);

				return c.json({
					...status.data,
					/**
					 * Whether a local attempt row matched this publish id. False is the
					 * documented pathological case where TikTok created the task but
					 * recording its publish id failed, so the creator is told this
					 * outcome is not being remembered.
					 */
					recorded,
				});
			}),
	);

	/**
	 * Direct Post: publish one video straight to the creator's profile.
	 * Irreversible at TikTok, which is what every guard here exists for.
	 *
	 * The attempt row is claimed BEFORE TikTok is asked to start anything, so a
	 * double-submitted form cannot originate two posts. A caller that loses the
	 * claim is handed the first attempt back and told to read its status.
	 */
	tiktok.post(
		'/api/integrations/tiktok/connections/:id/publish',
		describeRoute({
			description:
				"Publish a video directly to the connected creator's TikTok profile (video.publish). Idempotent per idempotencyKey.",
			tags: ['integrations', 'tiktok'],
		}),
		session,
		async (c) =>
			withConfig(c, async (config) => {
				const form = await c.req.parseBody().catch(() => null);
				if (!form) {
					return c.json(
						TikTokRouteError.InvalidRequest({
							detail: 'Expected a multipart form with a video file.',
						}),
						400,
					);
				}

				const idempotencyKey = form.idempotencyKey;
				if (!isValidIdempotencyKey(idempotencyKey)) {
					// Bounded on length and alphabet before it reaches a unique index.
					return c.json(
						TikTokRouteError.InvalidRequest({
							detail: `idempotencyKey is required so a repeated submit cannot originate a second post, and must be ${MIN_IDEMPOTENCY_KEY_LENGTH} to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters of [A-Za-z0-9._:-].`,
						}),
						400,
					);
				}
				const file = form.video;
				if (!(file instanceof File)) {
					return c.json(
						TikTokRouteError.InvalidRequest({
							detail: 'A video file is required.',
						}),
						400,
					);
				}
				if (file.size === 0 || file.size > MAX_SINGLE_CHUNK_BYTES) {
					return c.json(
						TikTokRouteError.InvalidRequest({
							detail: `The video must be between 1 byte and ${MAX_SINGLE_CHUNK_BYTES} bytes (one upload chunk).`,
						}),
						400,
					);
				}

				const opened = await openConnection(c, config);
				if ('failure' in opened) return opened.failure;
				const { api, db, row } = opened;

				// The bytes are read ONCE, before validation, because the duration
				// check below has to inspect the file this request will actually
				// upload rather than trust a number the browser put in the form.
				const bytes = new Uint8Array(await file.arrayBuffer());

				// Settings are validated against a LIVE creator_info read, never
				// against whatever the form claimed the options were.
				const creator = await api.readCreatorInfo();
				if (creator.error) return c.json(creator, 502);

				const privacyLevel = form.privacyLevel;
				if (
					typeof privacyLevel !== 'string' ||
					!(privacyLevels as readonly string[]).includes(privacyLevel)
				) {
					// Privacy is never defaulted: an absent or unknown value is a
					// refusal, not a silent fallback to some safe-looking level.
					return c.json(
						TikTokRouteError.InvalidRequest({
							detail: 'Choose who can see this post.',
						}),
						400,
					);
				}

				// One owner for every Direct Post rule (direct-post-policy.ts): the
				// creator's opt-ins, the commercial disclosure, the branded/private
				// refusal, caption limits, and the duration ceiling. It also performs
				// the opt-in to TikTok's `disable_*` translation, so that inversion
				// exists in exactly one place.
				const decided = validateDirectPost({
					creatorInfo: creator.data,
					choices: {
						title: typeof form.title === 'string' ? form.title : '',
						privacyLevel: privacyLevel as TikTokPrivacyLevel,
						interactions: {
							allowComment: readBoolean(form.allowComment),
							allowDuet: readBoolean(form.allowDuet),
							allowStitch: readBoolean(form.allowStitch),
						},
						commercial: {
							disclosed: readBoolean(form.commercialContent),
							yourBrand: readBoolean(form.yourBrand),
							brandedContent: readBoolean(form.brandedContent),
						},
						aiGenerated: readBoolean(form.aiGenerated),
						videoSize: file.size,
						// null when the container is not MP4. The policy REFUSES that
						// rather than deferring to TikTok: checking length is a
						// documented client responsibility, so an unverifiable file
						// fails closed. See mp4-duration.ts.
						durationSec: readMp4DurationSec(bytes),
					},
				});
				if ('violation' in decided) {
					// 409: the request was well-formed but conflicts with what this
					// account may currently post.
					return c.json(
						TikTokRouteError.CreatorSettingRefused({
							detail: decided.violation.message,
							field: decided.violation.field,
						}),
						409,
					);
				}
				const directPost = decided.input;

				// The commit latch. Whoever inserts this row is the only caller that
				// may reach `video/init` for this idempotency key.
				const { claimed, attempt } = await claimPublishAttempt(db, {
					id: nanoid(),
					connectionId: row.id,
					idempotencyKey,
					kind: 'direct_post',
				});
				if (!claimed) {
					return c.json(
						TikTokRouteError.PublishAlreadyAttempted({
							attemptId: attempt.id,
							publishId: attempt.publishId,
							status: attempt.status,
						}),
						409,
					);
				}

				const init = await api.initDirectPost(directPost);
				if (init.error) {
					// NOT every init failure means nothing happened. A definite 4xx
					// rejection means TikTok understood and refused, so no task exists.
					// A timeout, a dropped connection, a 5xx, or an `ok` envelope with
					// no publish_id all mean TikTok MAY have accepted the irreversible
					// init and we simply cannot see the answer. Collapsing those into
					// one INIT_FAILED would invite a retry that publishes twice.
					const ambiguous = isAmbiguousFailure(init.error);
					await recordAttemptOutcome(db, {
						attemptId: attempt.id,
						status: ambiguous ? 'INIT_AMBIGUOUS' : 'INIT_FAILED',
						failReason: init.error.message,
					});
					if (!ambiguous) return c.json(init, 502);
					return c.json(
						TikTokRouteError.PublishOutcomeUnknown({
							attemptId: attempt.id,
							publishId: null,
							detail: init.error.message,
						}),
						502,
					);
				}

				// Init succeeded, so the task exists at TikTok even if everything
				// after this fails. Record the publish id FIRST: it is the only
				// handle on that task, and losing it is what makes an outcome
				// unresolvable.
				//
				// UNAVOIDABLE WINDOW: TikTok has already created the task, and this
				// write is a separate system that can fail. There is no two-phase
				// commit available here because TikTok offers none. What IS guaranteed
				// is that the attempt row was claimed BEFORE the init, so the same
				// idempotency key still blocks a duplicate even when this write is
				// lost. The caller is told the attempt is unresolved rather than being
				// allowed to treat it as a fresh intent.
				try {
					await recordAttemptOutcome(db, {
						attemptId: attempt.id,
						publishId: init.data.publishId,
						status: 'PROCESSING_UPLOAD',
					});
				} catch (cause) {
					return c.json(
						TikTokRouteError.PublishOutcomeUnknown({
							attemptId: attempt.id,
							// Returned even though it could not be persisted: it is the
							// only handle on the task TikTok just created.
							publishId: init.data.publishId,
							detail: `TikTok accepted the post but Epicenter could not record it: ${extractErrorMessage(cause)}`,
						}),
						502,
					);
				}

				const upload = await api.uploadVideo(init.data.uploadUrl, bytes);
				if (upload.error) {
					// The task exists either way, so this is never a reason to start a
					// new one. Record what is known and point the caller at the status
					// read; the bytes may or may not have landed.
					await recordAttemptOutcome(db, {
						attemptId: attempt.id,
						status: 'UPLOAD_FAILED',
						failReason: upload.error.message,
					});
					return c.json(
						TikTokRouteError.PublishOutcomeUnknown({
							attemptId: attempt.id,
							publishId: init.data.publishId,
							detail: upload.error.message,
						}),
						502,
					);
				}

				return c.json({
					attemptId: attempt.id,
					publishId: init.data.publishId,
					// Deliberately not "published". TikTok publishing is asynchronous
					// and moderated; only a status read can say what happened.
					message:
						'TikTok accepted the video and is processing the post. This can take a few minutes.',
				});
			}),
	);
}
