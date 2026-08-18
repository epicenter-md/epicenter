import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { accountDir, ensureAccountDir, secureDbFiles } from './paths.ts';

/**
 * `intent.db`: the durable half of an account's local state, and the only
 * irreplaceable bytes Local Mail keeps (ADR-0198). It sits beside the mirror in
 * `<dataDir>/accounts/<accountEmail>/` rather than inside it, because the mirror is a
 * disposable copy of Gmail that a corpus-version bump replaces with a full
 * re-pull (ADR-0197), and a triage act the user made offline has to survive
 * that. The separation is mechanical, not merely intended: reclamation is scoped
 * to paths the mirror's `<name>.v<version>.db` grammar produces, and `intent.db`
 * is not one of them.
 *
 * What it holds is deliberately small: a partial map from `(message_id,
 * label_id)` to "wanted" or "not wanted", each row carrying the sequence number
 * it was asserted at. That is enough to answer both questions the system asks:
 *
 * - Reads: how do this message's effective labels differ from Gmail's facts?
 * - Delivery: what is still owed to Gmail, and is the answer I am holding still
 *   the current one?
 *
 * It is NOT a queue, an action log, a payload table, a retry counter, a
 * dead-letter table, a schedule, or a standing policy. The primary key is the
 * design: re-asserting a pair overwrites its `want` and takes a fresh `seq`, so
 * archive then unarchive then archive is one row rather than three acts, and the
 * store never grows with history. Nothing here talks to Gmail; `reconcile.ts` is
 * the only writer to the provider, and it is the only caller of `pending` and
 * `retire`.
 *
 * There are exactly two ways a row leaves. `retire` requires the sequence a
 * delivery actually proved, and `discardAll` is the human's explicit
 * abandonment. Neither is a guess about what Gmail already holds: an act cannot
 * erase an earlier act, it can only supersede it.
 *
 * `seq` comes from a counter in `_meta`, not from `max(seq) + 1`: retirement
 * empties the table, and a counter that restarted would let an in-flight
 * delivery retire a newer assertion that happened to reuse its number. It is the
 * whole mechanism behind "an older delivery cannot retire a newer assertion", so
 * it has to be monotonic for the life of the account, not the life of the rows.
 *
 * Durability is `synchronous = FULL`, unlike the mirror's `NORMAL`. The mirror
 * answers a lost commit by re-pulling from Gmail; this file has no such answer.
 */

/** One row of the map: this message should (or should not) carry this label. */
export type LabelIntent = {
	messageId: string;
	labelId: string;
	/** `true`: the label belongs on the message. `false`: it does not. */
	want: boolean;
	/** The account-monotonic sequence this row was last asserted at. */
	seq: number;
};

/** An opinion to record. `seq` is allocated by the store, never by the caller. */
export type LabelAssertion = Omit<LabelIntent, 'seq'>;

/** What is owed to Gmail right now, in aggregate. Deliberately two numbers and
 * no rows: enough for a status line to be honest about undelivered work without
 * any per-assertion status becoming durable state. */
export type PendingSummary = {
	assertions: number;
	/** ISO timestamp of the longest-waiting assertion, or `null` when none. */
	oldestAssertedAt: string | null;
};

export type IntentDbLocation = { dataDir: string; accountEmail: string };

export function intentDbPath(dataDir: string, accountEmail: string): string {
	return join(accountDir(dataDir, accountEmail), 'intent.db');
}

/**
 * The pending aggregate for an account, without creating anything. Two rules
 * meet here, and both matter:
 *
 * - A store that does not exist is honestly zero, and a read must not conjure a
 *   durable file (or an account directory) for an account that has none.
 * - A missing MIRROR says nothing at all about this. The mirror is replaced by a
 *   version bump and reclaimed on demand, and outliving that is the entire
 *   reason this file is separate, so undelivered work stays visible across a
 *   rebuild.
 */
export function readPendingSummary({
	dataDir,
	accountEmail,
}: IntentDbLocation): PendingSummary {
	if (!existsSync(intentDbPath(dataDir, accountEmail))) {
		return { assertions: 0, oldestAssertedAt: null };
	}
	const intent = openIntentDb({ dataDir, accountEmail });
	try {
		return intent.summary();
	} finally {
		intent.close();
	}
}

/**
 * Every undelivered assertion for one account, or nothing when the account has
 * no durable store yet.
 *
 * The absence rule is `readPendingSummary`'s, for the same reason: a read must
 * never conjure a durable file (or an account directory) for an account that
 * has none, so a surface that only wants to display effective labels can ask
 * about any account safely. A missing store means no local opinions, which
 * folds to Gmail's facts unchanged.
 *
 * Callers hand the result to `overlayOf`; nothing outside `overlay.ts`
 * interprets these rows for reading.
 */
export function readPendingIntents({
	dataDir,
	accountEmail,
}: IntentDbLocation): LabelIntent[] {
	if (!existsSync(intentDbPath(dataDir, accountEmail))) return [];
	const intent = openIntentDb({ dataDir, accountEmail });
	try {
		return intent.pending();
	} finally {
		intent.close();
	}
}

export type IntentDb = ReturnType<typeof openIntentDb>;

/**
 * Open (creating if needed) one account's durable intent store. Cheap enough to
 * call on any path that needs it: the file is a few pages, and every surface
 * that reads effective labels needs the schema to exist before it can attach it
 * (see `db.ts`).
 *
 * There is no migration step and no stored shape version, because this is a
 * pre-release clean break: `CREATE TABLE IF NOT EXISTS` is the whole of the
 * contract. Unlike the mirror, this file cannot answer a shape change by
 * rebuilding itself from Gmail, so a future change of shape is a product
 * decision with its own record, not something an opener quietly performs.
 */
export function openIntentDb({ dataDir, accountEmail }: IntentDbLocation) {
	ensureAccountDir(dataDir, accountEmail);
	const path = intentDbPath(dataDir, accountEmail);
	const db = new Database(path, { create: true });
	db.run('PRAGMA journal_mode = WAL;');
	db.run('PRAGMA busy_timeout = 5000;');
	// The mirror runs NORMAL because Gmail can rebuild it. Nothing can rebuild
	// this file, so it pays the fsync.
	db.run('PRAGMA synchronous = FULL;');
	db.run(`
		CREATE TABLE IF NOT EXISTS label_intents (
			message_id  TEXT    NOT NULL,
			label_id    TEXT    NOT NULL,
			want        INTEGER NOT NULL,
			seq         INTEGER NOT NULL,
			asserted_at TEXT    NOT NULL,
			PRIMARY KEY (message_id, label_id)
		);
		CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
	`);
	secureDbFiles(path);

	const readSeqStmt = db.query<{ value: string }, []>(
		`SELECT value FROM _meta WHERE key = 'next_seq'`,
	);
	const writeSeqStmt = db.query<never, [string]>(
		`INSERT INTO _meta (key, value) VALUES ('next_seq', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	);
	const upsertStmt = db.query<never, [string, string, number, number, string]>(
		`INSERT INTO label_intents (message_id, label_id, want, seq, asserted_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(message_id, label_id) DO UPDATE SET
		   want = excluded.want,
		   seq = excluded.seq,
		   asserted_at = excluded.asserted_at`,
	);
	const retireStmt = db.query<never, [string, string, number]>(
		`DELETE FROM label_intents
		 WHERE message_id = ? AND label_id = ? AND seq = ?`,
	);
	const discardAllStmt = db.query<never, []>(`DELETE FROM label_intents`);
	const pendingStmt = db.query<
		{ message_id: string; label_id: string; want: number; seq: number },
		[]
	>(`SELECT message_id, label_id, want, seq FROM label_intents ORDER BY seq`);
	const maxSeqStmt = db.query<{ seq: number | null }, []>(
		`SELECT max(seq) AS seq FROM label_intents`,
	);
	const summaryStmt = db.query<
		{ assertions: number; oldest_asserted_at: string | null },
		[]
	>(
		`SELECT count(*) AS assertions, min(asserted_at) AS oldest_asserted_at
		 FROM label_intents`,
	);

	/**
	 * The next sequence to hand out. The counter in `_meta` is the source, and it
	 * survives the table emptying; the `max(seq)` floor is there so a lost or
	 * unreadable counter can never hand out a number a live row already holds,
	 * which is the one thing that would let a stale delivery retire a newer wish.
	 */
	function nextSeq(): number {
		const stored = Number(readSeqStmt.get()?.value);
		const counter = Number.isSafeInteger(stored) && stored > 0 ? stored : 1;
		return Math.max(counter, (maxSeqStmt.get()?.seq ?? 0) + 1);
	}

	return {
		path,

		/**
		 * Record opinions, one fresh sequence per pair, in one transaction. Every
		 * opinion the act path passes is stored: this is the last word on each
		 * pair, not a judgement about whether it is worth delivering. `assertedAt`
		 * comes from the caller's clock and is the only thing that lets a surface
		 * say how long the oldest undelivered change has been waiting.
		 */
		assert(assertions: LabelAssertion[], assertedAt: string): number {
			if (assertions.length === 0) return 0;
			const tx = db.transaction(() => {
				let seq = nextSeq();
				for (const { messageId, labelId, want } of assertions) {
					upsertStmt.run(messageId, labelId, want ? 1 : 0, seq, assertedAt);
					seq += 1;
				}
				writeSeqStmt.run(String(seq));
				return assertions.length;
			});
			return tx.immediate();
		},

		/**
		 * How much is owed and how long the oldest has waited. Two aggregates, not
		 * a row listing: a surface should be able to say "3 changes, oldest 2
		 * minutes" without anything per-row becoming durable state.
		 */
		summary(): PendingSummary {
			const row = summaryStmt.get();
			return {
				assertions: row?.assertions ?? 0,
				oldestAssertedAt: row?.oldest_asserted_at ?? null,
			};
		},

		/** Everything still owed to Gmail, oldest assertion first. */
		pending(): LabelIntent[] {
			return pendingStmt.all().map((row) => ({
				messageId: row.message_id,
				labelId: row.label_id,
				want: row.want === 1,
				seq: row.seq,
			}));
		},

		/**
		 * Forget assertions Gmail has now confirmed. The `seq` match is the whole
		 * point: a pair re-asserted while the delivery was in flight carries a
		 * newer sequence, so this deletes nothing and the next pass delivers the
		 * newer opinion. Returns how many rows were actually retired.
		 */
		retire(retirements: LabelIntent[]): number {
			if (retirements.length === 0) return 0;
			const tx = db.transaction(() => {
				let retired = 0;
				for (const { messageId, labelId, seq } of retirements) {
					retired += retireStmt.run(messageId, labelId, seq).changes;
				}
				return retired;
			});
			return tx.immediate();
		},

		/**
		 * Abandon every undelivered assertion, and return how many were abandoned.
		 * This is the human bound on retrying: nothing ages out, nothing gives up
		 * after N attempts, so the only way an undelivered act stops being owed
		 * without reaching Gmail is somebody saying so (ADR-0199).
		 *
		 * Abandonment, not recall. An assertion this pass already delivered is
		 * already gone from the table, and one delivered a moment ago is Gmail's
		 * now; getting back is a new assertion like any other. The sequence counter
		 * is untouched, so a later assertion still cannot collide with an in-flight
		 * delivery's number.
		 */
		discardAll(): number {
			return discardAllStmt.run().changes;
		},

		close(): void {
			db.close();
		},
	};
}
