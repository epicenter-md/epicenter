/**
 * Postgres custody for TikTok connections, OAuth states, and publish attempts.
 *
 * Every function takes the request's `db` handle as its first argument, matching
 * the convention the other hosted cloud-db readers already use
 * (`readHostedPrincipalEmail(db, principalId)`).
 *
 * This module never decrypts. It moves ciphertext in and out of Postgres;
 * `tokens.ts` is the only thing that turns ciphertext into a usable token.
 */

import {
	type Db,
	tiktokConnection,
	tiktokOauthState,
	tiktokPublishAttempt,
} from '@epicenter/server/cloud-db';
import { and, desc, eq, lt } from 'drizzle-orm';

/** A stored connection, tokens included as ciphertext. */
export type StoredConnection = typeof tiktokConnection.$inferSelect;

/**
 * The connection shape that is safe to serialize to a browser: identity,
 * granted scopes, and expiry facts, with both token columns dropped.
 *
 * This is the ONLY shape any route returns. Omitting the ciphertext columns is
 * a type-level guarantee rather than a per-route reminder, so no future handler
 * can widen a response into leaking a token by forgetting to strip a field.
 */
export type PublicConnection = {
	id: string;
	openId: string;
	unionId: string | null;
	displayName: string;
	username: string | null;
	avatarUrl: string | null;
	scopes: string[];
	accessTokenExpiresAt: string;
	refreshTokenExpiresAt: string;
	createdAt: string;
	updatedAt: string;
};

export function toPublicConnection(row: StoredConnection): PublicConnection {
	return {
		id: row.id,
		openId: row.openId,
		unionId: row.unionId,
		displayName: row.displayName,
		username: row.username,
		avatarUrl: row.avatarUrl,
		scopes: row.scopes,
		accessTokenExpiresAt: row.accessTokenExpiresAt.toISOString(),
		refreshTokenExpiresAt: row.refreshTokenExpiresAt.toISOString(),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

// --- OAuth state ---------------------------------------------------------

export async function createOAuthState(
	db: Db,
	row: {
		state: string;
		userId: string;
		returnPath: string;
		expiresAt: Date;
	},
): Promise<void> {
	await db.insert(tiktokOauthState).values(row);
}

/**
 * Consume a state exactly once, for THIS user.
 *
 * `DELETE ... RETURNING` is the single-use guarantee: the delete and the read
 * are one statement, so two concurrent callbacks carrying the same state cannot
 * both receive a row. A replayed or forged state simply returns `null`.
 *
 * `userId` is part of the WHERE, not a check afterwards, and that difference is
 * the point. Matching on state alone would let a leaked state value be replayed
 * by anyone signed in: the row would be deleted (cancelling the real user's
 * in-flight ceremony) and only then found to belong to someone else. Scoping the
 * delete means another user's callback matches nothing and destroys nothing.
 *
 * Expiry is enforced by the CALLER against the returned `expiresAt` rather than
 * in the `WHERE`, so an expired state belonging to this user is still consumed
 * (removed) instead of being left behind for a later replay attempt.
 */
export async function consumeOAuthState(
	db: Db,
	{ state, userId }: { state: string; userId: string },
): Promise<typeof tiktokOauthState.$inferSelect | null> {
	const rows = await db
		.delete(tiktokOauthState)
		.where(
			and(
				eq(tiktokOauthState.state, state),
				eq(tiktokOauthState.userId, userId),
			),
		)
		.returning();
	return rows[0] ?? null;
}

/** Opportunistic sweep of states nobody came back for. */
export async function deleteExpiredOAuthStates(
	db: Db,
	now: Date,
): Promise<void> {
	await db.delete(tiktokOauthState).where(lt(tiktokOauthState.expiresAt, now));
}

// --- Connections ---------------------------------------------------------

export async function listConnections(
	db: Db,
	userId: string,
): Promise<StoredConnection[]> {
	return db
		.select()
		.from(tiktokConnection)
		.where(eq(tiktokConnection.userId, userId))
		.orderBy(tiktokConnection.createdAt);
}

/**
 * Read one connection, scoped to its owner. The `userId` is part of the
 * predicate rather than checked afterward, so a guessed connection id belonging
 * to another user reads as "not found" and never as a permission error that
 * would confirm the row exists.
 */
export async function readConnection(
	db: Db,
	{ userId, connectionId }: { userId: string; connectionId: string },
): Promise<StoredConnection | null> {
	const rows = await db
		.select()
		.from(tiktokConnection)
		.where(
			and(
				eq(tiktokConnection.id, connectionId),
				eq(tiktokConnection.userId, userId),
			),
		)
		.limit(1);
	return rows[0] ?? null;
}

/**
 * Insert a new connection, or update the existing one for this
 * (user, TikTok account) pair. Re-authorizing an account the user already
 * connected refreshes its tokens, identity, and granted scopes in place: it is
 * never a duplicate row and never a second identity.
 */
export async function upsertConnection(
	db: Db,
	row: typeof tiktokConnection.$inferInsert,
): Promise<StoredConnection> {
	const rows = await db
		.insert(tiktokConnection)
		.values(row)
		.onConflictDoUpdate({
			target: [tiktokConnection.userId, tiktokConnection.openId],
			set: {
				displayName: row.displayName,
				username: row.username ?? null,
				avatarUrl: row.avatarUrl ?? null,
				// Refreshed like every other identity field. TikTok returns a union id
				// only once the developer app is configured for it, so a connection
				// made before that would otherwise keep a null forever.
				unionId: row.unionId ?? null,
				scopes: row.scopes,
				accessTokenCiphertext: row.accessTokenCiphertext,
				accessTokenExpiresAt: row.accessTokenExpiresAt,
				refreshTokenCiphertext: row.refreshTokenCiphertext,
				refreshTokenExpiresAt: row.refreshTokenExpiresAt,
				updatedAt: new Date(),
			},
		})
		.returning();
	// The upsert always returns the affected row on either branch.
	return rows[0] as StoredConnection;
}

/** Returns whether a row was actually removed, so the caller can 404 honestly. */
export async function deleteConnection(
	db: Db,
	{ userId, connectionId }: { userId: string; connectionId: string },
): Promise<boolean> {
	const rows = await db
		.delete(tiktokConnection)
		.where(
			and(
				eq(tiktokConnection.id, connectionId),
				eq(tiktokConnection.userId, userId),
			),
		)
		.returning({ id: tiktokConnection.id });
	return rows.length > 0;
}

// --- Publish attempts ----------------------------------------------------

export type PublishAttempt = typeof tiktokPublishAttempt.$inferSelect;

/**
 * Claim the right to originate one publish, or hand back the attempt that
 * already owns this idempotency key.
 *
 * `ON CONFLICT DO NOTHING` plus a follow-up read is the whole concurrency
 * control for TikTok's irreversible `video/init`: whoever inserts the row is
 * the only caller that may proceed to init, and every duplicate submit observes
 * `claimed: false` and reports the existing attempt instead of originating a
 * second post.
 */
export async function claimPublishAttempt(
	db: Db,
	row: {
		id: string;
		connectionId: string;
		idempotencyKey: string;
		kind: 'direct_post' | 'draft_upload';
	},
): Promise<{ claimed: boolean; attempt: PublishAttempt }> {
	const inserted = await db
		.insert(tiktokPublishAttempt)
		.values(row)
		.onConflictDoNothing({
			target: [
				tiktokPublishAttempt.connectionId,
				tiktokPublishAttempt.idempotencyKey,
			],
		})
		.returning();
	const claimedRow = inserted[0];
	if (claimedRow) return { claimed: true, attempt: claimedRow };

	const existing = await db
		.select()
		.from(tiktokPublishAttempt)
		.where(
			and(
				eq(tiktokPublishAttempt.connectionId, row.connectionId),
				eq(tiktokPublishAttempt.idempotencyKey, row.idempotencyKey),
			),
		)
		.limit(1);
	// The insert conflicted, so the conflicting row exists.
	return { claimed: false, attempt: existing[0] as PublishAttempt };
}

export async function recordAttemptOutcome(
	db: Db,
	{
		attemptId,
		publishId,
		status,
		failReason,
	}: {
		attemptId: string;
		publishId?: string | null;
		status?: string | null;
		failReason?: string | null;
	},
): Promise<void> {
	await db
		.update(tiktokPublishAttempt)
		.set({
			...(publishId === undefined ? {} : { publishId }),
			...(status === undefined ? {} : { status }),
			...(failReason === undefined ? {} : { failReason }),
			updatedAt: new Date(),
		})
		.where(eq(tiktokPublishAttempt.id, attemptId));
}

export async function listPublishAttempts(
	db: Db,
	connectionId: string,
): Promise<PublishAttempt[]> {
	return db
		.select()
		.from(tiktokPublishAttempt)
		.where(eq(tiktokPublishAttempt.connectionId, connectionId))
		.orderBy(desc(tiktokPublishAttempt.createdAt))
		.limit(20);
}
