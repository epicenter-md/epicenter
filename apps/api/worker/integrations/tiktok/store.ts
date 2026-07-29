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
import { and, desc, eq, isNull, lt, notInArray, or } from 'drizzle-orm';
import {
	type AttemptStatus,
	type ManualResolution,
	PROCESSING_ATTEMPT_STATUSES,
	TERMINAL_ATTEMPT_STATUSES,
} from './attempt-status.js';

/** A stored connection, tokens included as ciphertext. */
export type StoredConnection = typeof tiktokConnection.$inferSelect;

/**
 * The connection shape that is safe to serialize to a browser: who the creator
 * is, whether they can post, and when the authorization runs out.
 *
 * This is the ONLY shape any route returns. Omitting the ciphertext columns is
 * a type-level guarantee rather than a per-route reminder, so no future handler
 * can widen a response into leaking a token by forgetting to strip a field.
 *
 * It answers the PRODUCT's questions rather than mirroring the row, and two
 * omissions are deliberate:
 *
 * - No `open_id` or `union_id`. They identify the account to TikTok, not to the
 *   creator, and a page that prints provider ids at somebody reads as an
 *   internal tool. `username` is TikTok's unique handle, which is what actually
 *   distinguishes two accounts a creator owns.
 * - No raw `scopes`. The only thing the UI does with a grant is decide whether
 *   this account can be posted to, so that judgement is made here, once, where
 *   the scope name lives. The alternative leaks TikTok's permission vocabulary
 *   into the interface and makes every consumer re-derive the same boolean.
 */
export type PublicConnection = {
	id: string;
	displayName: string;
	/** TikTok's unique @handle, absent if the creator declined `user.info.profile`. */
	username: string | null;
	avatarUrl: string | null;
	/** Whether this account granted the scope Direct Post needs. */
	canPost: boolean;
	accessTokenExpiresAt: string;
	refreshTokenExpiresAt: string;
	createdAt: string;
	updatedAt: string;
};

/**
 * The scope Direct Post cannot work without. A creator can decline it on
 * TikTok's consent screen, which leaves a real connection that simply cannot
 * publish, so it is a product state rather than an error.
 */
const DIRECT_POST_SCOPE = 'video.publish';

export function toPublicConnection(row: StoredConnection): PublicConnection {
	return {
		id: row.id,
		displayName: row.displayName,
		username: row.username,
		avatarUrl: row.avatarUrl,
		canPost: row.scopes.includes(DIRECT_POST_SCOPE),
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
		/**
		 * Which Content Posting product this row records. One literal, not a union:
		 * Direct Post is the only publishing product, so a caller has nothing to
		 * choose and no branch reads this back.
		 */
		kind: 'direct_post';
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

/**
 * Record what Epicenter knows about an attempt it is driving.
 *
 * `status` is typed as `AttemptStatus` rather than `string` so the vocabulary
 * `attempt-status.ts` describes is the vocabulary that can actually be written:
 * a code invented at a call site does not compile, and cannot reach the UI as a
 * status nothing knows how to describe.
 */
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
		status?: AttemptStatus | null;
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

/**
 * Write back what TikTok just said about one publishing task.
 *
 * Keyed on `(connection_id, publish_id)` rather than on the attempt id, because
 * the caller reading remote status holds a `publish_id` and the connection it
 * belongs to. Scoping to the connection is what keeps this from being a write
 * primitive one user could aim at another user's row.
 *
 * Returns whether a row matched. A miss is not an error: it is the one
 * pathological case this subsystem already documents, where TikTok created the
 * task but recording its `publish_id` failed. There is nothing local to
 * reconcile then, and TikTok's answer is still returned to the caller.
 *
 * Every field written is TikTok's own answer, so the write is idempotent and
 * re-reading a settled task changes nothing.
 */
export async function reconcileAttemptFromRemote(
	db: Db,
	{
		connectionId,
		publishId,
		status,
		publicPostIds,
		failReason,
	}: {
		connectionId: string;
		publishId: string;
		/** TikTok's own status code, stored verbatim. */
		status: string;
		publicPostIds: string[];
		failReason: string | null;
	},
): Promise<boolean> {
	const rows = await db
		.update(tiktokPublishAttempt)
		.set({
			status,
			publicPostIds,
			failReason,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(tiktokPublishAttempt.connectionId, connectionId),
				eq(tiktokPublishAttempt.publishId, publishId),
			),
		)
		.returning({ id: tiktokPublishAttempt.id });
	return rows.length > 0;
}

/**
 * The three safety predicates this module expresses in SQL.
 *
 * Named and exported so the grouping is reviewable and testable on its own
 * (`store.test.ts` renders each through `PgDialect`). Both are compound
 * `AND`/`OR` expressions where the parenthesization IS the rule: one misplaced
 * pair turns "a human may settle an unanswered attempt" into "a human may
 * overwrite a live post".
 *
 * Enforced in the WHERE rather than checked in a handler, so no caller can reach
 * past them.
 */

/**
 * Rows a HUMAN may adjudicate. A strict allowlist of the only two states with no
 * other exit: nothing named a task, and nothing has answered.
 *
 * Deliberately not "anything non-terminal", which is what this used to be. That
 * form admitted `PROCESSING_UPLOAD`, `PROCESSING_DOWNLOAD`, `UPLOAD_FAILED`, any
 * row that already held a `publish_id`, and every status a future TikTok might
 * introduce, so a creator's assertion could overwrite state the provider was
 * still willing to answer for. Mirrors `requiresManualResolution`.
 */
export function humanlyResolvableInSql() {
	return and(
		// A named task can always be polled, so asking TikTok beats letting anyone
		// declare a result.
		isNull(tiktokPublishAttempt.publishId),
		or(
			// Claimed, then the Worker died before recording anything.
			isNull(tiktokPublishAttempt.status),
			// The init whose answer was lost, so no task id was ever returned.
			eq(tiktokPublishAttempt.status, 'INIT_AMBIGUOUS'),
		),
	);
}

/**
 * Rows whose outcome has not settled, which is what makes a disconnect refusable.
 *
 * Broader than {@link blocksNewPublishInSql} on purpose: a post TikTok is merely
 * processing does not stop a new post, but it absolutely stops destroying the
 * connection, because revoking the token removes any way to ever ask what became
 * of it.
 *
 * Stated as an EXCLUSION of the settled statuses so it fails closed: a status this
 * build has never seen counts as unsettled and refuses the disconnect.
 */
export function unsettledInSql() {
	return or(
		isNull(tiktokPublishAttempt.status),
		notInArray(tiktokPublishAttempt.status, [...TERMINAL_ATTEMPT_STATUSES]),
	);
}

/**
 * Rows that must stop a NEW publish to this connection, with exactly the
 * semantics of `blocksNewPublish`: a status of `null`, or one that is neither
 * settled nor known to be processing at TikTok.
 *
 * Stated as EXCLUSIONS so it fails closed. Listing the blocking statuses instead
 * would let a status this build has never seen pass as though it were finished,
 * and the entire purpose of the block is that an outcome we cannot state stops
 * publishing.
 *
 * A post TikTok is merely processing does NOT block: we can say exactly what
 * happened to it, so a different post from a new consent is not a duplicate risk.
 */
export function blocksNewPublishInSql() {
	return or(
		isNull(tiktokPublishAttempt.status),
		and(
			notInArray(tiktokPublishAttempt.status, [...TERMINAL_ATTEMPT_STATUSES]),
			notInArray(tiktokPublishAttempt.status, [...PROCESSING_ATTEMPT_STATUSES]),
		),
	);
}

/**
 * Every attempt on this connection that has NOT settled.
 *
 * This is what makes disconnect refusable. The attempt table cascades on the
 * connection, so deleting a connection with a live or unknown attempt destroys
 * the only record that TikTok may be holding a post, and revoking the token
 * destroys the ability to ever ask. Custody has to outlive the impulse to
 * disconnect.
 *
 * See {@link unsettledInSql} for the predicate and why it fails closed.
 */
export async function listUnsettledAttempts(
	db: Db,
	connectionId: string,
): Promise<PublishAttempt[]> {
	return db
		.select()
		.from(tiktokPublishAttempt)
		.where(
			and(
				eq(tiktokPublishAttempt.connectionId, connectionId),
				unsettledInSql(),
			),
		)
		.orderBy(desc(tiktokPublishAttempt.createdAt));
}

/**
 * Every attempt on this connection whose outcome forbids starting another post.
 *
 * The SERVER-side half of the publish block. The dashboard derives the same block
 * from these rows, but a browser deriving a block is a courtesy, not a guarantee:
 * a direct or hostile client can change one field, mint a fresh idempotency key,
 * and walk straight past a UI that never runs. The idempotency latch does not
 * catch that either, because a new key is by definition a new claim.
 *
 * So the route consults this BEFORE claiming, and one creator consent can produce
 * at most one Direct Post whatever the client does.
 */
export async function listAttemptsBlockingNewPublish(
	db: Db,
	connectionId: string,
): Promise<PublishAttempt[]> {
	return db
		.select()
		.from(tiktokPublishAttempt)
		.where(
			and(
				eq(tiktokPublishAttempt.connectionId, connectionId),
				blocksNewPublishInSql(),
			),
		)
		.orderBy(desc(tiktokPublishAttempt.createdAt));
}

/**
 * Record a HUMAN's adjudication of an attempt nothing automated can resolve.
 *
 * The only way out of `INIT_AMBIGUOUS` or a null status: no publish id exists, so
 * TikTok cannot be asked, and without this the creator would be blocked from
 * posting to that account forever.
 *
 * The WHERE is an allowlist (see `humanlyResolvableInSql`), so this can never
 * overwrite a status TikTok supplied, a task TikTok could still be asked about,
 * or a status this build does not recognize. A double-submitted resolution is a
 * no-op rather than a rewrite. Returns whether a row actually moved.
 */
export async function resolveAttemptManually(
	db: Db,
	{
		connectionId,
		attemptId,
		status,
	}: {
		connectionId: string;
		attemptId: string;
		status: ManualResolution;
	},
): Promise<boolean> {
	const rows = await db
		.update(tiktokPublishAttempt)
		.set({ status, updatedAt: new Date() })
		.where(
			and(
				eq(tiktokPublishAttempt.id, attemptId),
				eq(tiktokPublishAttempt.connectionId, connectionId),
				humanlyResolvableInSql(),
			),
		)
		.returning({ id: tiktokPublishAttempt.id });
	return rows.length > 0;
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
