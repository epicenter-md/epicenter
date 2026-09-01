/**
 * Which accounts are connected: a person's own data, and the only place an
 * account's identity lives (ADR-0310).
 *
 * The row id Epicenter Data mints IS `accountId`. Everything else keys off it:
 * the secret that holds the refresh token, every row in the mail cache, and
 * every row in the durable intent store. Three consequences follow, and all
 * three are the point.
 *
 * **Google's `sub` is provider identity, not the key.** It is recorded as
 * `providerAccountId` because Google documents it as stable for the life of the
 * account while an email address may change. An address is display metadata,
 * and it is not a path segment, a filename, or a partition key any more.
 *
 * **The registry synchronizes and the credentials do not.** A new device shows
 * every account asking to be signed in, which is the correct reading of what a
 * secret is.
 *
 * **Deleting the mailbox does not sign anybody out.** The cache is disposable
 * (ADR-0306), so an account list living inside it would disappear with the
 * first reset.
 */

import type { LocalData } from '@epicenter/data';
import type database from './database.ts';

export type AccountRegistry = LocalData<typeof database>['tables']['accounts'];
export type AccountRecord = Parameters<AccountRegistry['create']>[0];
export type AccountRow = ReturnType<AccountRegistry['get']>;

/** Register an account and return Epicenter Data's generated row id. */
export function registerAccount(
	accounts: AccountRegistry,
	input: AccountRecord,
): string {
	return accounts.create(input).id;
}

export function accountById(
	accounts: AccountRegistry,
	accountId: string,
): AccountRow {
	return accounts.get(accountId);
}

/**
 * The row already recorded for one Google subject, or nothing.
 *
 * Reconnecting an account a person already has must land on the SAME row:
 * minting a second one would orphan the first account's cache and intent rows
 * behind an id nothing reaches, and would show the same mailbox twice.
 */
export function accountByProvider(
	accounts: AccountRegistry,
	{
		provider,
		providerAccountId,
	}: { provider: 'gmail'; providerAccountId: string },
): { id: string } | undefined {
	return accounts.rows.find(
		(row) =>
			row.provider === provider && row.providerAccountId === providerAccountId,
	);
}
