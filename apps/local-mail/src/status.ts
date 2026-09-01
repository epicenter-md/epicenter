/**
 * What one account's storage currently holds, for the status surface.
 *
 * Three questions with three owners, and the order matters. What is still owed
 * to Gmail is read FIRST and unconditionally, because an empty cache says
 * nothing about it: the cache is disposable and undelivered triage deliberately
 * outlives a reset (ADR-0306). Reporting zero pending because there is no cache
 * would hide a person's own work at exactly the moment it is most easily lost.
 *
 * There is no path, no filename, and no predecessor list here any more. The
 * cache is a database the runtime opened and the application never learns where
 * it landed, so "point sqlite3 at this file" stopped being something Local Mail
 * can say. What replaced it is the reset verb: a cache a person distrusts is
 * thrown away and pulled again.
 */

import type { PendingSummary } from './intent-store.ts';
import type { MailSession } from './accounts.ts';

export type MailStatus = {
	accountId: string;
	/**
	 * How much of this account's cache can be trusted. `empty` is nothing
	 * pulled; `building` is a cache whose history cursor has never been set, so
	 * no full pull has finished and the messages in it are a partial mailbox;
	 * `ready` is a cursor written by `finishFullPull`, after every page landed.
	 */
	cache: 'empty' | 'building' | 'ready';
	historyId: string | null;
	lastFullPullAt: string | null;
	lastSyncedAt: string | null;
	rows: { messages: number; labels: number };
	/**
	 * Local triage Gmail has not been told about: how much, and how long the
	 * oldest has waited. Aggregates only, so nothing per-row is durable enough
	 * to become a ledger (ADR-0199).
	 */
	pending: PendingSummary;
};

export async function readMailStatus({
	accountId,
	mailbox,
	intents,
}: MailSession): Promise<MailStatus> {
	const pending = await intents.summary();
	const [state, rows] = await Promise.all([
		mailbox.readCacheState(),
		mailbox.counts(),
	]);
	return {
		accountId,
		cache:
			state.historyId !== null
				? 'ready'
				: rows.messages === 0
					? 'empty'
					: 'building',
		historyId: state.historyId,
		lastFullPullAt: state.lastFullPullAt,
		lastSyncedAt: state.lastSyncedAt,
		rows,
		pending,
	};
}
