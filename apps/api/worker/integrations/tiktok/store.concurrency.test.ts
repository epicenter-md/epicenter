/**
 * REAL Postgres proof for the serialization the publish invariant depends on.
 *
 * Why this file exists at all: every other test in this subsystem drives a
 * scripted fake, and a fake answers whatever it was told to answer. It can show
 * that a route calls the right function in the right order, and it can show that a
 * WHERE clause renders the intended SQL, but it cannot show that two transactions
 * racing for the same row produce exactly one winner. That is a property of
 * Postgres, of `SELECT ... FOR UPDATE`, and of where the transaction boundaries
 * actually fall, so nothing short of a real database can establish it.
 *
 * WHAT THIS RUNS AGAINST, stated plainly so the proof is not overclaimed:
 *
 * - A scratch database created on a local Postgres, dropped and recreated per run.
 *   Never the developer's `epicenter` dev database.
 * - The repository's own migrations, applied in order, so the tables, the unique
 *   `(connection_id, idempotency_key)` index, and the `ON DELETE CASCADE` are the
 *   real ones rather than a hand-written approximation.
 * - Genuinely concurrent transactions over a connection pool, so `FOR UPDATE`
 *   really does make one of them wait.
 *
 * WHAT IT DOES NOT ESTABLISH: behaviour under Hyperdrive's pooling in production,
 * or under a serialization anomaly specific to a Postgres version other than the
 * one present here. It proves the lock does its job at READ COMMITTED, which is
 * the isolation level these transactions actually run at.
 *
 * SKIPPED, loudly, when no Postgres is reachable, so a clone without one still has
 * a green suite. A skip is not a pass: if this file reports skipped, the
 * concurrency claims in this subsystem are unproven for that run.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
/**
 * The Bun entry, not the root barrel: the root pulls in `cloudflare:workers`,
 * which does not exist outside the Workers runtime. `createDb` is the same
 * production function either way.
 */
import { createDb } from '@epicenter/server/bun';
import type { Db } from '@epicenter/server/cloud-db';
import {
	tiktokConnection,
	tiktokPublishAttempt,
} from '@epicenter/server/cloud-db';
import { eq } from 'drizzle-orm';
import { Client, Pool } from 'pg';
import { PUBLISH_LEASE_MS } from './attempt-status.js';
import {
	beginConnectionClose,
	claimPublishSlot,
	recordAttemptOutcome,
	resolveAttemptManually,
} from './store.js';

/**
 * The server this connects to. Overridable so a machine with Postgres somewhere
 * other than the repo's documented local default can still run the proof.
 */
const ADMIN_URL =
	process.env.TIKTOK_TEST_POSTGRES_URL ??
	'postgres://postgres:postgres@localhost:5432/postgres';
/** Dedicated, disposable, and deliberately not any database anyone develops against. */
const SCRATCH_DB = 'epicenter_tiktok_concurrency_test';
const SCRATCH_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${SCRATCH_DB}`);
const MIGRATIONS_DIR = join(import.meta.dir, '../../../drizzle');

async function postgresIsReachable(): Promise<boolean> {
	const client = new Client({
		connectionString: ADMIN_URL,
		connectionTimeoutMillis: 2_000,
	});
	try {
		await client.connect();
		await client.end();
		return true;
	} catch {
		return false;
	}
}

const reachable = await postgresIsReachable();
/**
 * `test` when a database is present, `test.skip` otherwise. Named so a reader
 * scanning results can tell a genuine pass from an absent database.
 */
const dbTest = reachable ? test : test.skip;
if (!reachable) {
	console.warn(
		`[tiktok] No Postgres at ${ADMIN_URL}: SKIPPING the concurrency proof. The publish serialization is UNPROVEN for this run.`,
	);
}

let pool: Pool;
/**
 * The REAL `Db` type the store functions take, built over the real schema, so
 * nothing here is reached through a cast that could hide a shape mismatch.
 */
let db: Db;

/** Apply the repo's real migrations, in order, so the schema is not approximated. */
async function applyMigrations(client: Client): Promise<void> {
	const files = (await readdir(MIGRATIONS_DIR))
		.filter((name) => name.endsWith('.sql'))
		.sort();
	for (const name of files) {
		const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
		for (const statement of sql.split('--> statement-breakpoint')) {
			const trimmed = statement.trim();
			if (trimmed.length > 0) await client.query(trimmed);
		}
	}
}

beforeAll(async () => {
	if (!reachable) return;
	const admin = new Client({ connectionString: ADMIN_URL });
	await admin.connect();
	// Dropped first so a previous run's rows can never be mistaken for this one's.
	await admin.query(`drop database if exists ${SCRATCH_DB} with (force)`);
	await admin.query(`create database ${SCRATCH_DB}`);
	await admin.end();

	const scratch = new Client({ connectionString: SCRATCH_URL });
	await scratch.connect();
	await applyMigrations(scratch);
	await scratch.end();

	// Room for several genuinely simultaneous transactions: with a pool of one,
	// "concurrent" calls would queue on the client and prove nothing about locking.
	pool = new Pool({ connectionString: SCRATCH_URL, max: 8 });
	// The PRODUCTION constructor, so the handle under test is bound to the same
	// schema the Worker uses rather than one assembled here.
	db = createDb(pool);
});

afterAll(async () => {
	if (!reachable) return;
	await pool.end();
	const admin = new Client({ connectionString: ADMIN_URL });
	await admin.connect();
	await admin.query(`drop database if exists ${SCRATCH_DB} with (force)`);
	await admin.end();
});

let seq = 0;

/** A user and one connected account, fresh per test so tests cannot interfere. */
async function seedConnection(): Promise<{
	userId: string;
	connectionId: string;
}> {
	seq += 1;
	const userId = `user-${seq}`;
	const connectionId = `conn-${seq}`;
	// Raw SQL for the owner row: `user` belongs to Better Auth's schema and is not
	// part of this subsystem's surface. Only the FK target matters here.
	await pool.query(`insert into "user" (id, name, email) values ($1, $2, $3)`, [
		userId,
		`Creator ${seq}`,
		`creator-${seq}@example.test`,
	]);
	await db.insert(tiktokConnection).values({
		id: connectionId,
		userId,
		openId: `open-${seq}`,
		displayName: `Creator ${seq}`,
		username: `creator${seq}`,
		scopes: ['video.publish'],
		accessTokenCiphertext: 'v1.a.b',
		accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
		refreshTokenCiphertext: 'v1.a.b',
		refreshTokenExpiresAt: new Date(Date.now() + 3_600_000),
	});
	return { userId, connectionId };
}

// --- The race the reviewer identified ------------------------------------

dbTest(
	'two concurrent claims with DIFFERENT fresh keys: exactly one commits',
	async () => {
		/**
		 * THE PROOF THIS FILE EXISTS FOR. The old gate read "is anything blocking",
		 * then inserted, as two statements. Two requests with different idempotency
		 * keys both saw nothing blocking, both inserted (different keys do not
		 * collide on the unique index), and both went on to TikTok's irreversible
		 * init. No scripted fake can demonstrate that, and none can demonstrate the
		 * fix either.
		 *
		 * TWO-way is timing-dependent as a DETECTOR: removing the row lock leaves this
		 * case passing by luck, because at READ COMMITTED two transactions often
		 * happen to serialize anyway. The eight-way fan-out below is the reliable
		 * one, and both are kept because this states the property and that one
		 * enforces it.
		 */
		const { userId, connectionId } = await seedConnection();

		const [first, second] = await Promise.all([
			claimPublishSlot(db, {
				id: 'attempt-a',
				userId,
				connectionId,
				idempotencyKey: 'key-aaaaaaaaaaaa',
			}),
			claimPublishSlot(db, {
				id: 'attempt-b',
				userId,
				connectionId,
				idempotencyKey: 'key-bbbbbbbbbbbb',
			}),
		]);

		const outcomes = [first.outcome, second.outcome].sort();
		expect(outcomes).toEqual(['blocked', 'claimed']);

		// And the database agrees: one attempt row, not two.
		const rows = await db
			.select()
			.from(tiktokPublishAttempt)
			.where(eq(tiktokPublishAttempt.connectionId, connectionId));
		expect(rows).toHaveLength(1);
		// The winner holds a live lease, which is what makes it ACTIVE rather than
		// abandoned.
		expect(rows[0]?.leaseExpiresAt).not.toBeNull();
		expect(rows[0]?.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
	},
);

dbTest(
	'eight concurrent claims with distinct keys still commit exactly one',
	async () => {
		/**
		 * The hostile-client shape: fan out N different keys at once and hope one slips
		 * through beside another. The lock queues all of them behind one decision.
		 *
		 * This is the case that actually FAILS when the lock is removed, verified by
		 * deleting `.for('update')` and watching it go red. Treat it as the regression
		 * guard for the serialization, not the two-way test above.
		 */
		const { userId, connectionId } = await seedConnection();

		const results = await Promise.all(
			Array.from({ length: 8 }, (_unused, index) =>
				claimPublishSlot(db, {
					id: `attempt-${index}`,
					userId,
					connectionId,
					idempotencyKey: `key-${String(index).repeat(12)}`,
				}),
			),
		);

		expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
		expect(results.filter((r) => r.outcome === 'blocked')).toHaveLength(7);
		const rows = await db
			.select()
			.from(tiktokPublishAttempt)
			.where(eq(tiktokPublishAttempt.connectionId, connectionId));
		expect(rows).toHaveLength(1);
	},
);

dbTest(
	'two concurrent claims with the SAME key: one claims, one duplicates',
	async () => {
		// The unique index handles this one, and it must keep handling it: the second
		// caller has to learn it lost rather than being told nothing is wrong.
		const { userId, connectionId } = await seedConnection();

		const results = await Promise.all([
			claimPublishSlot(db, {
				id: 'attempt-x',
				userId,
				connectionId,
				idempotencyKey: 'key-same-key-01',
			}),
			claimPublishSlot(db, {
				id: 'attempt-y',
				userId,
				connectionId,
				idempotencyKey: 'key-same-key-01',
			}),
		]);

		// The loser is `blocked` or `duplicate` depending on which side of the winner's
		// commit it read; both refuse, and neither may proceed to init.
		expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
		expect(
			results.filter(
				(r) => r.outcome === 'blocked' || r.outcome === 'duplicate',
			),
		).toHaveLength(1);
		const rows = await db
			.select()
			.from(tiktokPublishAttempt)
			.where(eq(tiktokPublishAttempt.connectionId, connectionId));
		expect(rows).toHaveLength(1);
	},
);

dbTest(
	'a settled prior attempt does not block a genuinely new consent',
	async () => {
		// The mirror: serialization must not become a permanent lock.
		const { userId, connectionId } = await seedConnection();
		const first = await claimPublishSlot(db, {
			id: 'attempt-1',
			userId,
			connectionId,
			idempotencyKey: 'key-first-00001',
		});
		expect(first.outcome).toBe('claimed');
		await recordAttemptOutcome(db, {
			attemptId: 'attempt-1',
			status: 'PUBLISH_COMPLETE',
		});

		const second = await claimPublishSlot(db, {
			id: 'attempt-2',
			userId,
			connectionId,
			idempotencyKey: 'key-second-0001',
		});

		expect(second.outcome).toBe('claimed');
	},
);

// --- Publish against disconnect ------------------------------------------

dbTest('publish and disconnect cannot both succeed', async () => {
	/**
	 * Both orderings are legitimate; what must never happen is both committing.
	 * If the claim wins, the disconnect sees an unsettled attempt and refuses, so
	 * custody survives. If the disconnect wins, the claim sees `closing_at` and
	 * refuses, so no post starts against a credential being revoked.
	 */
	const { userId, connectionId } = await seedConnection();

	const [claim, close] = await Promise.all([
		claimPublishSlot(db, {
			id: 'attempt-race',
			userId,
			connectionId,
			idempotencyKey: 'key-race-000001',
		}),
		beginConnectionClose(db, { userId, connectionId }),
	]);

	const claimWon = claim.outcome === 'claimed';
	const closeWon = close.outcome === 'closing';
	// Exactly one, never both.
	expect(claimWon !== closeWon).toBe(true);

	if (claimWon) {
		expect(close.outcome).toBe('unsettled');
		// Custody intact: the attempt row still exists to be reconciled.
		const rows = await db
			.select()
			.from(tiktokPublishAttempt)
			.where(eq(tiktokPublishAttempt.connectionId, connectionId));
		expect(rows).toHaveLength(1);
	} else {
		expect(claim.outcome).toBe('closing');
	}
});

dbTest('once closing, every later claim refuses', async () => {
	const { userId, connectionId } = await seedConnection();
	const close = await beginConnectionClose(db, { userId, connectionId });
	expect(close.outcome).toBe('closing');

	const claim = await claimPublishSlot(db, {
		id: 'attempt-after-close',
		userId,
		connectionId,
		idempotencyKey: 'key-afterclose1',
	});

	expect(claim.outcome).toBe('closing');
	// Nothing was inserted, so the refusal cost no durable state.
	const rows = await db
		.select()
		.from(tiktokPublishAttempt)
		.where(eq(tiktokPublishAttempt.connectionId, connectionId));
	expect(rows).toHaveLength(0);
});

dbTest(
	'beginConnectionClose is idempotent, so an interrupted disconnect is retryable',
	async () => {
		// `closing_at` is never cleared, so a disconnect that died between marking and
		// deleting must be resumable rather than leaving a stuck account.
		const { userId, connectionId } = await seedConnection();

		const first = await beginConnectionClose(db, { userId, connectionId });
		const second = await beginConnectionClose(db, { userId, connectionId });

		expect(first.outcome).toBe('closing');
		expect(second.outcome).toBe('closing');
		if (first.outcome === 'closing' && second.outcome === 'closing') {
			// The same instant, not a moving target.
			expect(second.connection.closingAt?.getTime()).toBe(
				first.connection.closingAt?.getTime(),
			);
		}
	},
);

dbTest('a claim on another user’s connection reads as missing', async () => {
	const { connectionId } = await seedConnection();

	const claim = await claimPublishSlot(db, {
		id: 'attempt-foreign',
		userId: 'somebody-else',
		connectionId,
		idempotencyKey: 'key-foreign-001',
	});

	expect(claim.outcome).toBe('missing');
});

// --- Manual resolution against an ACTIVE claim ---------------------------

dbTest(
	'a human cannot settle an attempt whose lease is still live',
	async () => {
		/**
		 * The shape `(publish_id IS NULL, status IS NULL)` is BOTH a healthy publish
		 * mid-flight and the wreckage of a dead Worker. Before the lease existed, a
		 * creator recording "nothing was posted" could land on the first, marking it
		 * terminal while the original request went on to publish.
		 */
		const { userId, connectionId } = await seedConnection();
		const claim = await claimPublishSlot(db, {
			id: 'attempt-live',
			userId,
			connectionId,
			idempotencyKey: 'key-live-000001',
		});
		expect(claim.outcome).toBe('claimed');

		const resolved = await resolveAttemptManually(db, {
			connectionId,
			attemptId: 'attempt-live',
			status: 'RESOLVED_NOT_POSTED',
		});

		expect(resolved).toBe(false);
		const rows = await db
			.select()
			.from(tiktokPublishAttempt)
			.where(eq(tiktokPublishAttempt.id, 'attempt-live'));
		// Untouched: still an active claim, not somebody's guess.
		expect(rows[0]?.status).toBeNull();
	},
);

dbTest(
	'a human CAN settle the same attempt once its lease has expired',
	async () => {
		// The abandoned case: the Worker died, nothing will ever answer, and the
		// creator is the only remaining source of truth.
		const { userId, connectionId } = await seedConnection();
		await claimPublishSlot(db, {
			id: 'attempt-stale',
			userId,
			connectionId,
			idempotencyKey: 'key-stale-00001',
		});

		const afterLease = new Date(Date.now() + PUBLISH_LEASE_MS + 1_000);
		const resolved = await resolveAttemptManually(db, {
			connectionId,
			attemptId: 'attempt-stale',
			status: 'RESOLVED_NOT_POSTED',
			now: afterLease,
		});

		expect(resolved).toBe(true);
		const rows = await db
			.select()
			.from(tiktokPublishAttempt)
			.where(eq(tiktokPublishAttempt.id, 'attempt-stale'));
		expect(rows[0]?.status).toBe('RESOLVED_NOT_POSTED');
	},
);

dbTest(
	'a resolved attempt no longer blocks, so the creator can post again',
	async () => {
		const { userId, connectionId } = await seedConnection();
		await claimPublishSlot(db, {
			id: 'attempt-abandoned',
			userId,
			connectionId,
			idempotencyKey: 'key-abandoned-1',
		});
		await resolveAttemptManually(db, {
			connectionId,
			attemptId: 'attempt-abandoned',
			status: 'RESOLVED_NOT_POSTED',
			now: new Date(Date.now() + PUBLISH_LEASE_MS + 1_000),
		});

		const next = await claimPublishSlot(db, {
			id: 'attempt-next',
			userId,
			connectionId,
			idempotencyKey: 'key-next-000001',
		});

		expect(next.outcome).toBe('claimed');
	},
);

dbTest(
	'an outcome write cannot overwrite a human’s recorded answer',
	async () => {
		// The other side of the lease: if a creator did settle an attempt, the original
		// request must not quietly replace their answer when it finally writes.
		const { userId, connectionId } = await seedConnection();
		await claimPublishSlot(db, {
			id: 'attempt-contested',
			userId,
			connectionId,
			idempotencyKey: 'key-contested-1',
		});
		await resolveAttemptManually(db, {
			connectionId,
			attemptId: 'attempt-contested',
			status: 'RESOLVED_POSTED',
			now: new Date(Date.now() + PUBLISH_LEASE_MS + 1_000),
		});

		const wrote = await recordAttemptOutcome(db, {
			attemptId: 'attempt-contested',
			publishId: 'pub-late',
			status: 'PROCESSING_UPLOAD',
		});

		expect(wrote).toBe(false);
		const rows = await db
			.select()
			.from(tiktokPublishAttempt)
			.where(eq(tiktokPublishAttempt.id, 'attempt-contested'));
		expect(rows[0]?.status).toBe('RESOLVED_POSTED');
		expect(rows[0]?.publishId).toBeNull();
	},
);

dbTest('the FIRST outcome write on a fresh claim still lands', async () => {
	/**
	 * Guards the SQL-NULL trap the manual-resolution guard introduces. In Postgres
	 * `NULL NOT IN (...)` is NULL rather than true, so writing that guard without an
	 * `IS NULL` arm would refuse the first write to every freshly claimed row and
	 * break every publish. That failure is invisible to a mock.
	 */
	const { userId, connectionId } = await seedConnection();
	await claimPublishSlot(db, {
		id: 'attempt-fresh',
		userId,
		connectionId,
		idempotencyKey: 'key-fresh-00001',
	});

	const wrote = await recordAttemptOutcome(db, {
		attemptId: 'attempt-fresh',
		publishId: 'pub-fresh',
		status: 'PROCESSING_UPLOAD',
	});

	expect(wrote).toBe(true);
	const rows = await db
		.select()
		.from(tiktokPublishAttempt)
		.where(eq(tiktokPublishAttempt.id, 'attempt-fresh'));
	expect(rows[0]?.status).toBe('PROCESSING_UPLOAD');
	expect(rows[0]?.publishId).toBe('pub-fresh');
});

dbTest('the unique index on (connection, key) is the real one', async () => {
	// The migrations, not a hand-written approximation, are what this file applies.
	const { userId, connectionId } = await seedConnection();
	await claimPublishSlot(db, {
		id: 'attempt-u1',
		userId,
		connectionId,
		idempotencyKey: 'key-unique-0001',
	});
	await recordAttemptOutcome(db, {
		attemptId: 'attempt-u1',
		status: 'PUBLISH_COMPLETE',
	});

	// Same key again, now that nothing blocks: the index must still refuse it.
	const again = await claimPublishSlot(db, {
		id: 'attempt-u2',
		userId,
		connectionId,
		idempotencyKey: 'key-unique-0001',
	});

	expect(again.outcome).toBe('duplicate');
});
