/**
 * One account's slice of the durable intent store: the only irreplaceable bytes
 * Local Mail keeps (ADR-0198).
 *
 * It lives in its own SQLite database rather than beside the cache, because the
 * cache is a disposable copy of Gmail that a reset replaces with a full re-pull
 * (ADR-0306), and a triage act a person made offline has to survive that. The
 * separation is mechanical: `reset` on the mailbox holds no handle to this
 * database and cannot reach it.
 *
 * What it holds is deliberately small: a partial map from `(message, label)` to
 * wanted or not wanted, each row carrying the sequence it was asserted at. That
 * answers both questions the system asks. Reads: how do this message's effective
 * labels differ from Gmail's facts? Delivery: what is still owed, and is the
 * answer I am holding still the current one?
 *
 * There are exactly two ways a row leaves. `retire` requires the sequence a
 * delivery actually proved, and `discardAll` is a person's explicit abandonment.
 * Neither is a guess about what Gmail already holds: an act cannot erase an
 * earlier act, it can only supersede it (ADR-0199).
 */

import type { AppSqliteDatabase } from '@epicenter/app';
import { sqliteHandle } from './handle.ts';

/** One row of the map: this message should, or should not, carry this label. */
export type LabelIntent = {
	messageId: string;
	labelId: string;
	want: boolean;
	/** The account-monotonic sequence this row was last asserted at. */
	seq: number;
};

/** An opinion to record. `seq` is allocated by the store, never by the caller. */
export type LabelAssertion = Omit<LabelIntent, 'seq'>;

/**
 * What is owed to Gmail right now, in aggregate. Two numbers and no rows: a
 * status line can be honest about undelivered work without anything per
 * assertion becoming durable state.
 */
export type PendingSummary = {
	assertions: number;
	/** ISO timestamp of the longest-waiting assertion, or `null` when none. */
	oldestAssertedAt: string | null;
};

export type IntentStore = ReturnType<typeof openIntentStore>;

export function openIntentStore(intent: AppSqliteDatabase, accountId: string) {
	const { all, batch } = sqliteHandle(intent);

	/**
	 * The next sequence to hand out.
	 *
	 * The counter in `intent_meta` is the source and survives the table emptying.
	 * The `max(seq)` floor is there so a lost or unreadable counter can never
	 * hand out a number a live row already holds, which is the one thing that
	 * would let a stale delivery retire a newer wish.
	 */
	async function nextSeq(): Promise<number> {
		const [counter] = await all<{ value: string | null }>(
			`SELECT value FROM intent_meta WHERE account_id = ? AND key = 'next_seq'`,
			[accountId],
		);
		const [highest] = await all<{ seq: number | null }>(
			`SELECT max(seq) AS seq FROM label_intents WHERE account_id = ?`,
			[accountId],
		);
		const stored = Number(counter?.value);
		const fromCounter =
			Number.isSafeInteger(stored) && stored > 0 ? stored : 1;
		return Math.max(fromCounter, (highest?.seq ?? 0) + 1);
	}

	return {
		accountId,

		/**
		 * Record opinions, one fresh sequence per pair, in one batch.
		 *
		 * Every opinion the act path passes is stored: this is the last word on
		 * each pair, not a judgement about whether it is worth delivering.
		 */
		async assert(
			assertions: readonly LabelAssertion[],
			assertedAt: string,
		): Promise<number> {
			if (assertions.length === 0) return 0;
			let seq = await nextSeq();
			const statements = assertions.map((assertion) => {
				const at = seq;
				seq += 1;
				return {
					sql: `INSERT INTO label_intents
					        (account_id, message_id, label_id, want, seq, asserted_at)
					      VALUES (?, ?, ?, ?, ?, ?)
					      ON CONFLICT(account_id, message_id, label_id) DO UPDATE SET
					        want = excluded.want,
					        seq = excluded.seq,
					        asserted_at = excluded.asserted_at`,
					parameters: [
						accountId,
						assertion.messageId,
						assertion.labelId,
						assertion.want ? 1 : 0,
						at,
						assertedAt,
					] as const,
				};
			});
			await batch([
				...statements,
				{
					sql: `INSERT INTO intent_meta (account_id, key, value)
					      VALUES (?, 'next_seq', ?)
					      ON CONFLICT(account_id, key) DO UPDATE SET value = excluded.value`,
					parameters: [accountId, String(seq)] as const,
				},
			]);
			return assertions.length;
		},

		async summary(): Promise<PendingSummary> {
			const [row] = await all<{
				assertions: number;
				oldest_asserted_at: string | null;
			}>(
				`SELECT count(*) AS assertions, min(asserted_at) AS oldest_asserted_at
				 FROM label_intents WHERE account_id = ?`,
				[accountId],
			);
			return {
				assertions: row?.assertions ?? 0,
				oldestAssertedAt: row?.oldest_asserted_at ?? null,
			};
		},

		/** Everything still owed to Gmail, oldest assertion first. */
		async pending(): Promise<LabelIntent[]> {
			const rows = await all<{
				message_id: string;
				label_id: string;
				want: number;
				seq: number;
			}>(
				`SELECT message_id, label_id, want, seq FROM label_intents
				 WHERE account_id = ? ORDER BY seq`,
				[accountId],
			);
			return rows.map((row) => ({
				messageId: row.message_id,
				labelId: row.label_id,
				want: row.want === 1,
				seq: row.seq,
			}));
		},

		/**
		 * Forget assertions Gmail has now confirmed.
		 *
		 * The sequence match is the whole point: a pair re-asserted while the
		 * delivery was in flight carries a newer sequence, so this deletes nothing
		 * and the next pass delivers the newer opinion.
		 */
		async retire(retirements: readonly LabelIntent[]): Promise<number> {
			if (retirements.length === 0) return 0;
			const changes = await batch(
				retirements.map((retirement) => ({
					sql: `DELETE FROM label_intents
					      WHERE account_id = ? AND message_id = ? AND label_id = ? AND seq = ?`,
					parameters: [
						accountId,
						retirement.messageId,
						retirement.labelId,
						retirement.seq,
					] as const,
				})),
			);
			return changes.reduce((total, change) => total + change, 0);
		},

		/**
		 * Abandon every undelivered assertion, and report how many.
		 *
		 * This is the human bound on retrying: nothing ages out and nothing gives
		 * up after N attempts, so the only way an undelivered act stops being owed
		 * without reaching Gmail is somebody saying so (ADR-0199). The sequence
		 * counter is untouched, so a later assertion still cannot collide with an
		 * in-flight delivery's number.
		 */
		async discardAll(): Promise<number> {
			const [changes] = await batch([
				{
					sql: `DELETE FROM label_intents WHERE account_id = ?`,
					parameters: [accountId],
				},
			]);
			return changes ?? 0;
		},
	};
}
