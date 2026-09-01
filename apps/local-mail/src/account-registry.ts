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

export function accountById(accounts: AccountRegistry, accountId: string): AccountRow {
	return accounts.get(accountId);
}
