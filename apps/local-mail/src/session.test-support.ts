/**
 * One account's mailbox and intent store over in-memory databases, for tests.
 *
 * The two databases are separate here for the same reason they are separate in
 * production: a cache reset must not be able to reach a person's undelivered
 * triage. A fixture that shared one database would make that promise untestable.
 */

import type { AppSqliteDatabase } from '@epicenter/app';
import { createTestAppSqlite } from './app-sqlite.test-support.ts';
import { openIntentStore, type IntentStore } from './intent-store.ts';
import { openMailbox, type Mailbox } from './mailbox.ts';
import { MAIL_CACHE_SCHEMA, MAIL_INTENT_SCHEMA } from './storage.ts';

export type TestSession = {
	accountId: string;
	mailbox: Mailbox;
	intents: IntentStore;
	/** The two databases, for a test that reopens handles over them. */
	mailboxDatabase: AppSqliteDatabase;
	intentDatabase: AppSqliteDatabase;
	/**
	 * One row straight out of the cache, for a test that wants to see what
	 * landed rather than what a read model says about it.
	 */
	row<TRow>(
		sql: string,
		parameters?: readonly (string | number | null)[],
	): Promise<TRow | undefined>;
	close(): void;
};

export async function openTestSession(
	accountId = 'account-one',
): Promise<TestSession> {
	const mail = createTestAppSqlite();
	const intent = createTestAppSqlite();
	for (const sql of MAIL_CACHE_SCHEMA) {
		const applied = await mail.run(sql);
		if (applied.error !== null) throw applied.error;
	}
	for (const sql of MAIL_INTENT_SCHEMA) {
		const applied = await intent.run(sql);
		if (applied.error !== null) throw applied.error;
	}
	return {
		accountId,
		mailboxDatabase: mail,
		intentDatabase: intent,
		mailbox: openMailbox(mail, accountId),
		intents: openIntentStore(intent, accountId),
		async row<TRow>(
			sql: string,
			parameters: readonly (string | number | null)[] = [],
		) {
			const rows = await mail.all(sql, parameters);
			if (rows.error !== null) throw rows.error;
			return rows.data[0] as TRow | undefined;
		},
		close: () => {
			mail.close();
			intent.close();
		},
	};
}
