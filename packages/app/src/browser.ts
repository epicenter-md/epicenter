/// <reference lib="dom" />

/**
 * The standalone browser leaf: IndexedDB data, origin-owned SQLite, and
 * secrets that live exactly as long as the tab (ADR-0310).
 *
 * This is the reduced build. It has no keychain and no host, so it holds no
 * credential across a reload, deliberately and permanently: not `localStorage`,
 * not IndexedDB, and not encrypted in the page, because a key the page can
 * derive is a key anything in the origin can derive.
 */

import { Ok, tryAsync } from 'wellcrafted/result';
import {
	AppError,
	type AppSqliteDatabase,
	type EpicenterBinding,
	type SecretStore,
} from './index.js';
import { createBrowserSqliteFactory } from './browser-sqlite.js';
import { openClientOwnedData } from './client-owned-data.js';

type BrowserSqliteFactory = (
	appId: string,
	name: string,
) => Promise<AppSqliteDatabase>;

export function createBrowserBinding(options: {
	appId: string;
	sqlite?: BrowserSqliteFactory;
}): EpicenterBinding {
	const sqlite = options.sqlite ?? createBrowserSqliteFactory();
	return {
		openData: openClientOwnedData,
		openSqlite: (name) =>
			tryAsync({
				try: () => sqlite(options.appId, name),
				catch: (cause) => AppError.StorageFailed({ cause }),
			}),
		secrets: createTabMemorySecrets(),
	};
}

/** In memory, for the life of the tab, permanently rather than provisionally. */
function createTabMemorySecrets(): SecretStore {
	const values = new Map<string, string>();
	return {
		put: async (accountId, value) => {
			values.set(accountId, value);
			return Ok(undefined);
		},
		get: async (accountId) => Ok(values.get(accountId) ?? null),
		delete: async (accountId) => {
			values.delete(accountId);
			return Ok(undefined);
		},
	};
}
