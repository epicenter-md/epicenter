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
	MANUAL_RESOLUTIONS,
	type ManualResolution,
	PROCESSING_ATTEMPT_STATUSES,
	PUBLISH_LEASE_MS,
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
	/**
	 * Whether a disconnect has begun for this account.
	 *
	 * Surfaced because `closing_at` is never cleared: a disconnect interrupted
	 * between marking and deleting leaves an account that refuses new posts, and a
	 * creator who only learned that by having a post refused would have no idea
	 * why. The list says so plainly and offers to finish the disconnect.
	 */
	closing: boolean;
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
		closing: row.closingAt !== null,
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
 *
 * REFUSES to overwrite a human's answer. If a lease expired while this request was
 * somehow still alive, a creator may already have recorded an outcome, and their
 * statement is the one made with eyes on TikTok. Returns whether a row moved, so
 * the caller can report an unrecorded outcome instead of assuming it landed.
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
): Promise<boolean> {
	const rows = await db
		.update(tiktokPublishAttempt)
		.set({
			...(publishId === undefined ? {} : { publishId }),
			...(status === undefined ? {} : { status }),
			...(failReason === undefined ? {} : { failReason }),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(tiktokPublishAttempt.id, attemptId),
				/**
				 * A creator's recorded outcome is authoritative over anything this
				 * request would write afterwards.
				 *
				 * The `IS NULL` arm is load-bearing, not defensive: in SQL
				 * `NULL NOT IN (...)` evaluates to NULL rather than true, so a bare
				 * `NOT IN` would refuse the FIRST write to every freshly claimed row and
				 * break every publish.
				 */
				or(
					isNull(tiktokPublishAttempt.status),
					notInArray(tiktokPublishAttempt.status, [...MANUAL_RESOLUTIONS]),
				),
			),
		)
		.returning({ id: tiktokPublishAttempt.id });
	return rows.length > 0;
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
export function humanlyResolvableInSql(now: Date) {
	return and(
		// A named task can always be polled, so asking TikTok beats letting anyone
		// declare a result.
		isNull(tiktokPublishAttempt.publishId),
		or(
			// The init whose answer was lost, so no task id was ever returned. Written
			// by the request that then returns, so nothing still holds it.
			eq(tiktokPublishAttempt.status, 'INIT_AMBIGUOUS'),
			/**
			 * A claim nobody is working on any more. The LEASE is what says so: this
			 * exact shape is also a healthy publish mid-flight between its claim and
			 * its first outcome write, and admitting that one is how a creator's
			 * "nothing was posted" lands on a request that then publishes.
			 *
			 * A NULL lease is admitted because it means the row predates leases, so no
			 * live request can be holding it.
			 */
			and(
				isNull(tiktokPublishAttempt.status),
				or(
					isNull(tiktokPublishAttempt.leaseExpiresAt),
					lt(tiktokPublishAttempt.leaseExpiresAt, now),
				),
			),
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
 * The result of asking for the right to publish to one connection.
 *
 * A single union rather than a boolean, because the four refusals mean genuinely
 * different things to the creator and to the client's idempotency claim.
 */
export type PublishSlot =
	/** The caller owns this attempt and may proceed to `video/init`. */
	| { outcome: 'claimed'; attempt: PublishAttempt }
	/** A prior attempt's outcome cannot be stated; nothing new may start. */
	| { outcome: 'blocked'; attempt: PublishAttempt }
	/** This exact idempotency key already owns an attempt. */
	| { outcome: 'duplicate'; attempt: PublishAttempt }
	/** A disconnect has begun for this account. */
	| { outcome: 'closing' }
	/** The connection is gone (deleted, or never belonged to this user). */
	| { outcome: 'missing' };

/**
 * Take the right to publish to one connection, ATOMICALLY.
 *
 * This exists because the guard it replaces was a check-then-insert across two
 * statements, and that is not a guard at all under concurrency. Two requests with
 * DIFFERENT idempotency keys could both read "nothing is blocking", both insert,
 * and both reach TikTok's irreversible `video/init`. The unique
 * `(connection_id, idempotency_key)` index does not help: different keys do not
 * collide, so the index only ever caught the same intent submitted twice.
 *
 * The fix is to make the whole decision one serialized step. `SELECT ... FOR
 * UPDATE` on the CONNECTION row is the serialization point, the same pattern
 * `tokens.ts` already uses to make token refresh single-flight, so every publish
 * claim and every disconnect for one account queues behind the same lock. Inside
 * it the blocking recheck and the insert cannot be separated by another
 * transaction, so at most one fresh claim can ever commit while an outcome is
 * unknown.
 *
 * The connection row is also the right granularity: the invariant is per account,
 * so locking it serializes exactly the operations that can conflict and nothing
 * else. Two different accounts never wait on each other.
 *
 * Order note: this locks ONE row and takes no second lock, so it cannot deadlock
 * against itself or against the disconnect path below.
 */
export async function claimPublishSlot(
	db: Db,
	{
		id,
		userId,
		connectionId,
		idempotencyKey,
		now = new Date(),
	}: {
		id: string;
		/** Scoped to the owner, so a guessed connection id reads as missing. */
		userId: string;
		connectionId: string;
		idempotencyKey: string;
		now?: Date;
	},
): Promise<PublishSlot> {
	return db.transaction(async (tx) => {
		// THE SERIALIZATION POINT. Everything below observes state no other
		// transaction can change until this one commits.
		const locked = await tx
			.select()
			.from(tiktokConnection)
			.where(
				and(
					eq(tiktokConnection.id, connectionId),
					eq(tiktokConnection.userId, userId),
				),
			)
			.for('update')
			.limit(1);
		const connection = locked[0];
		if (!connection) return { outcome: 'missing' } as const;
		// A disconnect got here first. It is about to revoke the token and delete
		// this row, so starting a post now would reach TikTok with a credential
		// being withdrawn and leave a post whose local record is being erased.
		// Truthy rather than `!== null`: a Date is truthy and both null and an absent
		// column are not, so this cannot be tripped by a row that simply lacks the
		// field.
		if (connection.closingAt) return { outcome: 'closing' } as const;

		// Rechecked INSIDE the lock. The advisory check the route makes earlier is
		// only there to avoid a provider call in the common case; this is the one
		// that decides.
		// Same shape as `listAttemptsBlockingNewPublish`, deliberately: one predicate,
		// read the same way in both places, so the advisory check and the
		// authoritative one cannot drift into asking different questions.
		const blocking = await tx
			.select()
			.from(tiktokPublishAttempt)
			.where(
				and(
					eq(tiktokPublishAttempt.connectionId, connectionId),
					blocksNewPublishInSql(),
				),
			)
			.orderBy(desc(tiktokPublishAttempt.createdAt));
		const blocker = blocking[0];
		if (blocker) return { outcome: 'blocked', attempt: blocker } as const;

		const inserted = await tx
			.insert(tiktokPublishAttempt)
			.values({
				id,
				connectionId,
				idempotencyKey,
				kind: 'direct_post',
				// The lease starts now: from here until it expires, this attempt is
				// ACTIVE and nobody else may decide its outcome.
				leaseExpiresAt: new Date(now.getTime() + PUBLISH_LEASE_MS),
			})
			.onConflictDoNothing({
				target: [
					tiktokPublishAttempt.connectionId,
					tiktokPublishAttempt.idempotencyKey,
				],
			})
			.returning();
		const claimed = inserted[0];
		if (claimed) return { outcome: 'claimed', attempt: claimed } as const;

		// The insert conflicted, so this key already owns an attempt. It cannot be a
		// blocking one, because the recheck above found none.
		const existing = await tx
			.select()
			.from(tiktokPublishAttempt)
			.where(
				and(
					eq(tiktokPublishAttempt.connectionId, connectionId),
					eq(tiktokPublishAttempt.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);
		return {
			outcome: 'duplicate',
			attempt: existing[0] as PublishAttempt,
		} as const;
	});
}

/** What happened when a disconnect asked to begin. */
export type ConnectionClose =
	/** Marked closing; the caller may now revoke and delete. */
	| { outcome: 'closing'; connection: StoredConnection }
	/** An attempt has not settled, so custody must not be destroyed. */
	| { outcome: 'unsettled'; unsettled: number }
	| { outcome: 'missing' };

/**
 * Begin disconnecting, ATOMICALLY, under the same lock a publish claim takes.
 *
 * The unsettled-attempt check used to be a plain read followed by a revoke and a
 * delete, which races publishing in both directions: a publish could claim a slot
 * after the check and then have its attempt row cascade-deleted, and a publish
 * that already held a token could reach TikTok while its custody was being
 * removed.
 *
 * Taking the same `FOR UPDATE` lock closes both. A publish that got there first
 * has already inserted its attempt row, so the recheck here sees it and refuses.
 * A disconnect that gets there first marks `closing_at`, and every later claim
 * refuses on it, including during the revoke and delete that follow this
 * transaction.
 *
 * Marking is committed BEFORE the provider call deliberately: the alternative is
 * holding a database lock across a network round trip to TikTok.
 */
export async function beginConnectionClose(
	db: Db,
	{ userId, connectionId }: { userId: string; connectionId: string },
): Promise<ConnectionClose> {
	return db.transaction(async (tx) => {
		const locked = await tx
			.select()
			.from(tiktokConnection)
			.where(
				and(
					eq(tiktokConnection.id, connectionId),
					eq(tiktokConnection.userId, userId),
				),
			)
			.for('update')
			.limit(1);
		const connection = locked[0];
		if (!connection) return { outcome: 'missing' } as const;

		const unsettled = await tx
			.select({ id: tiktokPublishAttempt.id })
			.from(tiktokPublishAttempt)
			.where(
				and(
					eq(tiktokPublishAttempt.connectionId, connectionId),
					unsettledInSql(),
				),
			);
		if (unsettled.length > 0) {
			return { outcome: 'unsettled', unsettled: unsettled.length } as const;
		}

		// Idempotent: a disconnect interrupted after this point can be retried, and
		// re-marking an already-closing connection is a no-op.
		const marked = await tx
			.update(tiktokConnection)
			.set({ closingAt: connection.closingAt ?? new Date() })
			.where(eq(tiktokConnection.id, connectionId))
			.returning();
		return {
			outcome: 'closing',
			connection: (marked[0] ?? connection) as StoredConnection,
		} as const;
	});
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
		now = new Date(),
	}: {
		connectionId: string;
		attemptId: string;
		status: ManualResolution;
		/** Injected so the lease boundary is testable without waiting ten minutes. */
		now?: Date;
	},
): Promise<boolean> {
	const rows = await db
		.update(tiktokPublishAttempt)
		.set({ status, updatedAt: new Date() })
		.where(
			and(
				eq(tiktokPublishAttempt.id, attemptId),
				eq(tiktokPublishAttempt.connectionId, connectionId),
				humanlyResolvableInSql(now),
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
