/**
 * Connected third-party publishing accounts.
 *
 * These tables are deliberately NOT the Better Auth `account` table, and the
 * distinction is the whole point of the subsystem:
 *
 * - `account` rows are LOGIN identities. Better Auth resolves
 *   `POST /auth/sign-in/social` against whatever sits in `socialProviders`
 *   (better-auth 1.6.23 `api/routes/sign-in.mjs`: the handler looks the provider
 *   up in that map and has no per-provider "linking only" flag), so registering
 *   TikTok there would silently open a new Epicenter sign-in door. It would also
 *   feed Better Auth's TikTok provider, whose `getUserInfo` maps
 *   `email: user.email || user.username` — TikTok issues no email, so a username
 *   would land in `user.email`, a `notNull().unique()` column.
 * - `account` additionally carries an explicit v1 promise of one same-provider
 *   account per user (see its `account_providerId_accountId_unique` comment),
 *   while a creator routinely authorizes a dozen or more TikTok accounts.
 *
 * So a connected publishing account is a CAPABILITY GRANT keyed to a Better Auth
 * user, never a credential that can sign anybody in. Nothing here is reachable
 * from any Better Auth endpoint.
 *
 * Placement note: table definitions live in `@epicenter/server` because
 * `apps/api/drizzle.config.ts` points drizzle-kit at this schema barrel, so a
 * migration can only be generated for tables it can see. Everything that is
 * actually hosted-only POLICY (routes, token custody, the TikTok client) lives in
 * `apps/api/worker/integrations/`, which the self-hosted instance never composes.
 * These tables are inert for a deployment that mounts no integration routes.
 */

import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { user } from './auth';

/**
 * One authorized TikTok account, held on behalf of one Epicenter user.
 *
 * Both token columns hold versioned ciphertext (`v<n>.<iv>.<ct>`, AES-256-GCM),
 * never a bearable secret, so a database read alone cannot publish as the
 * creator. The encryption key is a hosted binding the database never sees.
 */
export const tiktokConnection = pgTable(
	'tiktok_connection',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		/**
		 * TikTok's per-application stable id for the creator. This is the identity
		 * the grant belongs to, and the one shown in the UI beside the display name
		 * so a creator with many accounts can tell them apart.
		 */
		openId: text('open_id').notNull(),
		/** Stable across the developer's apps. Present only when `user.info.basic` returns it. */
		unionId: text('union_id'),
		displayName: text('display_name').notNull(),
		username: text('username'),
		avatarUrl: text('avatar_url'),
		/**
		 * Exactly the scopes TikTok granted, which can be NARROWER than the scopes
		 * requested: the consent screen lets a creator decline individual ones. The
		 * UI renders this list verbatim rather than the requested set, so a partial
		 * grant is visible instead of assumed.
		 */
		scopes: text('scopes').array().notNull(),
		accessTokenCiphertext: text('access_token_ciphertext').notNull(),
		accessTokenExpiresAt: timestamp('access_token_expires_at').notNull(),
		refreshTokenCiphertext: text('refresh_token_ciphertext').notNull(),
		refreshTokenExpiresAt: timestamp('refresh_token_expires_at').notNull(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [
		index('tiktokConnection_userId_idx').on(table.userId),
		/**
		 * One row per (Epicenter user, TikTok account): re-authorizing an already
		 * connected account is an upsert, not a duplicate, and many DISTINCT TikTok
		 * accounts on one user are the expected case.
		 *
		 * Deliberately scoped to the user rather than globally unique on `open_id`,
		 * which is where this departs from `account`. A login identity must map to
		 * exactly one user or sign-in would be ambiguous. A publishing grant is not
		 * an identity: two Epicenter users can each hold a real, independently
		 * revocable grant to the same TikTok account (a creator and the manager they
		 * authorized), and TikTok itself issues both. A global unique would make the
		 * second, equally valid grant unrepresentable.
		 */
		unique('tiktok_connection_userId_openId_unique').on(
			table.userId,
			table.openId,
		),
	],
);

/**
 * A single-use, expiry-bound OAuth `state` for one in-flight connect ceremony.
 *
 * A Postgres row rather than a signed cookie because the callback must survive
 * any Worker isolate and must bind to the Epicenter user who STARTED the flow.
 * The row is consumed with `DELETE ... RETURNING`, so replaying a state is a
 * miss, not a second connection.
 */
export const tiktokOauthState = pgTable(
	'tiktok_oauth_state',
	{
		/** The opaque `state` value handed to TikTok. */
		state: text('state').primaryKey(),
		/**
		 * The Epicenter user who began the ceremony. The callback compares this
		 * against its own session, so a state minted in one account can never
		 * attach a TikTok account to another.
		 */
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		/** PKCE verifier; only its S256 challenge ever left this server. */
		codeVerifier: text('code_verifier').notNull(),
		/** Same-origin dashboard path to return to. Validated to start with `/`. */
		returnPath: text('return_path').notNull(),
		expiresAt: timestamp('expires_at').notNull(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(table) => [
		index('tiktokOauthState_userId_idx').on(table.userId),
		index('tiktokOauthState_expiresAt_idx').on(table.expiresAt),
	],
);

/**
 * One attempted publish, recorded BEFORE TikTok is asked to start it.
 *
 * TikTok's `video/init` is irreversible and its `publish_id` is the only handle
 * on the resulting task, so a lost response is indistinguishable from a lost
 * post. The unique `(connection_id, idempotency_key)` is what makes a repeated
 * submit structurally unable to originate a second post: the second insert
 * loses the race and the caller is handed the first attempt's row instead.
 * An ambiguous outcome is then resolved by READING TikTok's status, never by
 * retrying the init.
 */
export const tiktokPublishAttempt = pgTable(
	'tiktok_publish_attempt',
	{
		id: text('id').primaryKey(),
		connectionId: text('connection_id')
			.notNull()
			.references(() => tiktokConnection.id, { onDelete: 'cascade' }),
		/** Caller-supplied; one per intended post. */
		idempotencyKey: text('idempotency_key').notNull(),
		/** `direct_post` (video.publish) or `draft_upload` (video.upload). */
		kind: text('kind').notNull(),
		/**
		 * Null between the row being claimed and TikTok answering `video/init`.
		 * A null `publish_id` on an old row is exactly the ambiguous case: the init
		 * may or may not have landed, and only TikTok can say.
		 */
		publishId: text('publish_id'),
		/** Last status observed from `status/fetch`, or `INIT_FAILED`. */
		status: text('status'),
		failReason: text('fail_reason'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [
		index('tiktokPublishAttempt_connectionId_idx').on(table.connectionId),
		unique('tiktok_publish_attempt_connectionId_idempotencyKey_unique').on(
			table.connectionId,
			table.idempotencyKey,
		),
	],
);

export const tiktokConnectionRelations = relations(
	tiktokConnection,
	({ one, many }) => ({
		user: one(user, {
			fields: [tiktokConnection.userId],
			references: [user.id],
		}),
		publishAttempts: many(tiktokPublishAttempt),
	}),
);

export const tiktokOauthStateRelations = relations(
	tiktokOauthState,
	({ one }) => ({
		user: one(user, {
			fields: [tiktokOauthState.userId],
			references: [user.id],
		}),
	}),
);

export const tiktokPublishAttemptRelations = relations(
	tiktokPublishAttempt,
	({ one }) => ({
		connection: one(tiktokConnection, {
			fields: [tiktokPublishAttempt.connectionId],
			references: [tiktokConnection.id],
		}),
	}),
);
