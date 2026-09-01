/// <reference lib="dom" />

import {
	createGeneration,
	newestGeneration,
	openDatabase,
} from '@epicenter/data/browser';
import type { DataDefinition } from '@epicenter/data/definition';
import type { LocalData } from '@epicenter/data';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import {
	AppError,
	type AppSqliteDatabase,
	type EpicenterBinding,
	type SecretStore,
} from './index.js';
import { createBrowserSqliteFactory } from './browser-sqlite.js';

type BrowserSqliteFactory = (
	appId: string,
	name: string,
) => Promise<AppSqliteDatabase>;

/** Browser binding: IndexedDB data, origin-owned SQLite, and tab memory secrets. */
export function createBrowserBinding(options: {
	appId: string;
	sqlite?: BrowserSqliteFactory;
}): EpicenterBinding {
	const secrets = new Map<string, string>();
	const sqlite = options.sqlite ?? createBrowserSqliteFactory();
	return {
		openData: openBrowserData,
		openSqlite: async (name) => {
			const result = await tryAsync({
				try: () => sqlite(options.appId, name),
				catch: (cause) => AppError.StorageFailed({ cause }),
			});
			return result;
		},
		secrets: createMemorySecrets(secrets),
	};
}

async function openBrowserData<TDefinition extends DataDefinition>(
	definition: TDefinition,
): Promise<Result<LocalData<TDefinition>, AppError>> {
	const generation = await newestGeneration(definition.id);
	if (generation === undefined) {
		const created = await createGeneration(definition);
		if (created.error !== null) return AppError.StorageFailed({ cause: created.error });
		return openBrowserGeneration(definition, created.data.generation);
	}
	return openBrowserGeneration(definition, generation);
}

async function openBrowserGeneration<TDefinition extends DataDefinition>(
	definition: TDefinition,
	generation: number,
): Promise<Result<LocalData<TDefinition>, AppError>> {
	const opened = await openDatabase(definition, { generation });
	return opened.error === null
		? Ok(opened.data)
		: AppError.StorageFailed({ cause: opened.error });
}

function createMemorySecrets(values: Map<string, string>): SecretStore {
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

export type { BrowserSqliteFactory };
