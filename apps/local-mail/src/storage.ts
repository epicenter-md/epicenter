import type { AppSqliteDatabase, EpicenterHandle } from '@epicenter/app';
import type { LocalData } from '@epicenter/data';
import database from './database.ts';
import type { AccountRegistry } from './account-registry.ts';

/**
 * Local Mail's three storage concerns, opened through one scoped handle.
 *
 * | | what it is | where it lives |
 * | --- | --- | --- |
 * | which accounts are connected | a person's own data | Epicenter Data |
 * | the mail itself | borrowed data | `mail`, disposable |
 * | what this machine still owes Gmail | a person's own act | `intent`, durable |
 *
 * Two SQLite databases rather than one, because their deletion policies differ
 * and nothing else does (ADR-0306). `mail` is a copy of Gmail and may be
 * cleared and re-pulled at any moment; `intent` holds triage a person performed
 * that Gmail has not been told about, and nothing can rebuild it. A cache reset
 * that touched `intent` would throw away the only irreplaceable bytes this
 * application keeps, and keeping them in one file is how that happens by
 * accident.
 *
 * Every row in both is partitioned by `accountId`, which is the row id Epicenter
 * Data minted for the account (never the Google `sub`, and never an email
 * address). One database holds every connected account, so connecting a second
 * one opens no second file and names no second path.
 */

export const LOCAL_MAIL_APP_ID = 'so.epicenter.local-mail';

/**
 * The two mirror folders Local Mail claims under its data id (ADR-0315).
 *
 * `local` is this machine's view and `account` is whichever account the person
 * is currently showing. Switching which account `account` represents replaces
 * that folder's contents, so it asks first: see `account-switch.ts`.
 */
export const LOCAL_MAIL_FOLDERS = {
	local: 'local',
	account: 'account',
} as const;

export type LocalMailStorage = {
	data: LocalData<typeof database>;
	mail: AppSqliteDatabase;
	intent: AppSqliteDatabase;
	accounts: AccountRegistry;
	folder: typeof LOCAL_MAIL_FOLDERS;
};

/** Compose Local Mail's account registry, cache, and durable intent handles. */
export async function openLocalMailStorage(
	epicenter: EpicenterHandle,
): Promise<LocalMailStorage> {
	const dataResult = await epicenter.openData(database);
	if (dataResult.error !== null) throw dataResult.error;
	const mailResult = await epicenter.openSqlite('mail');
	if (mailResult.error !== null) throw mailResult.error;
	const intentResult = await epicenter.openSqlite('intent');
	if (intentResult.error !== null) throw intentResult.error;
	await applySchema(mailResult.data, MAIL_CACHE_SCHEMA);
	await applySchema(intentResult.data, MAIL_INTENT_SCHEMA);
	return {
		data: dataResult.data,
		mail: mailResult.data,
		intent: intentResult.data,
		accounts: dataResult.data.tables.accounts,
		folder: LOCAL_MAIL_FOLDERS,
	};
}

async function applySchema(
	database: AppSqliteDatabase,
	statements: readonly string[],
): Promise<void> {
	const applied = await database.batch(statements.map((sql) => ({ sql })));
	if (applied.error !== null) throw applied.error;
}

/**
 * The disposable copy of Gmail.
 *
 * Three tiers and no fourth (ADR-0196): the verbatim `messages.get` resource,
 * every column SQLite can project from it, and exactly the columns SQL cannot
 * project that pushed-down search and sort need. A generated column cannot
 * disagree with the resource it came from, which is why every column that can
 * be one is one.
 *
 * There is no stored shape version and no versioned filename here any more.
 * This data is borrowed, so a shape change is answered by clearing these tables
 * and pulling Gmail again, which is a verb the application owns rather than a
 * migration an opener performs.
 */
export const MAIL_CACHE_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS cache_meta (
		account_id TEXT NOT NULL,
		key TEXT NOT NULL,
		value TEXT,
		PRIMARY KEY (account_id, key)
	)`,
	`CREATE TABLE IF NOT EXISTS messages (
		account_id TEXT NOT NULL,
		id TEXT NOT NULL,
		resource TEXT NOT NULL,
		thread_id TEXT GENERATED ALWAYS AS (json_extract(resource, '$.threadId')) VIRTUAL,
		snippet TEXT GENERATED ALWAYS AS (json_extract(resource, '$.snippet')) STORED,
		label_ids TEXT GENERATED ALWAYS AS (json_extract(resource, '$.labelIds')) VIRTUAL,
		internal_date INTEGER GENERATED ALWAYS AS (CAST(json_extract(resource, '$.internalDate') AS INTEGER)) STORED,
		subject TEXT,
		sender TEXT,
		body_text TEXT,
		synced_at TEXT NOT NULL,
		PRIMARY KEY (account_id, id)
	)`,
	`CREATE TABLE IF NOT EXISTS labels (
		account_id TEXT NOT NULL,
		id TEXT NOT NULL,
		resource TEXT NOT NULL,
		name TEXT GENERATED ALWAYS AS (json_extract(resource, '$.name')) VIRTUAL,
		type TEXT GENERATED ALWAYS AS (json_extract(resource, '$.type')) VIRTUAL,
		synced_at TEXT NOT NULL,
		PRIMARY KEY (account_id, id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_messages_recent ON messages(account_id, internal_date DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(account_id, thread_id, internal_date)`,
] as const;

/**
 * The durable half: a partial map from `(account, message, label)` to wanted or
 * not wanted, each row carrying the sequence it was asserted at.
 *
 * Not a queue, an action log, a retry counter, or a schedule. The primary key
 * is the design: re-asserting a pair overwrites its `want` and takes a fresh
 * sequence, so archive then unarchive then archive is one row rather than
 * three, and the store never grows with history.
 *
 * `intent_meta` holds the per-account sequence counter, which has to be
 * monotonic for the life of the account rather than the life of the rows:
 * retirement empties the table, and a counter that restarted would let an
 * in-flight delivery retire a newer assertion that reused its number.
 */
export const MAIL_INTENT_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS label_intents (
		account_id TEXT NOT NULL,
		message_id TEXT NOT NULL,
		label_id TEXT NOT NULL,
		want INTEGER NOT NULL,
		seq INTEGER NOT NULL,
		asserted_at TEXT NOT NULL,
		PRIMARY KEY (account_id, message_id, label_id)
	)`,
	`CREATE TABLE IF NOT EXISTS intent_meta (
		account_id TEXT NOT NULL,
		key TEXT NOT NULL,
		value TEXT,
		PRIMARY KEY (account_id, key)
	)`,
] as const;
