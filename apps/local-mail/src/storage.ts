import type {
	AppSqliteDatabase,
	EpicenterHandle,
} from '@epicenter/app';
import type { LocalData } from '@epicenter/data';
import database from './database.ts';
import type { AccountRegistry } from './account-registry.ts';

export const LOCAL_MAIL_APP_ID = 'so.epicenter.local-mail';
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
	return {
		data: dataResult.data,
		mail: mailResult.data,
		intent: intentResult.data,
		accounts: dataResult.data.tables.accounts,
		folder: LOCAL_MAIL_FOLDERS,
	};
}

export const MAIL_CACHE_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS cache_meta (account_id TEXT PRIMARY KEY, history_id TEXT, synced_at TEXT)`,
	`CREATE TABLE IF NOT EXISTS messages (account_id TEXT NOT NULL, id TEXT NOT NULL, thread_id TEXT NOT NULL, internal_date INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (account_id, id))`,
	`CREATE TABLE IF NOT EXISTS labels (account_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (account_id, id))`,
] as const;

export const MAIL_INTENT_SCHEMA = [
	`CREATE TABLE IF NOT EXISTS label_intents (account_id TEXT NOT NULL, message_id TEXT NOT NULL, label_id TEXT NOT NULL, want INTEGER NOT NULL, seq INTEGER NOT NULL, asserted_at TEXT NOT NULL, PRIMARY KEY (account_id, message_id, label_id))`,
] as const;
