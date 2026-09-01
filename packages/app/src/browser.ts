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

/**
 * Open the newest generation of this definition's client-owned store, minting
 * one when the machine has never held it.
 *
 * Shared with the desktop leaf, because a person's Epicenter Data is
 * client-owned in every runtime: the host serves bundles and brokers
 * capabilities, and owns no application data (ADR-0226, ADR-0227).
 */
export async function openClientOwnedData<TDefinition extends DataDefinition>(
	definition: TDefinition,
): Promise<Result<LocalData<TDefinition>, AppError>> {
	const generation = await newestGeneration(definition.id);
	if (generation === undefined) {
		const created = await createGeneration(definition);
		if (created.error !== null) {
			return AppError.StorageFailed({ cause: created.error });
		}
		return openGeneration(definition, created.data.generation);
	}
	return openGeneration(definition, generation);
}

async function openGeneration<TDefinition extends DataDefinition>(
	definition: TDefinition,
	generation: number,
): Promise<Result<LocalData<TDefinition>, AppError>> {
	const opened = await openDatabase(definition, { generation });
	return opened.error === null
		? Ok(opened.data)
		: AppError.StorageFailed({ cause: opened.error });
}

/** In memory, for the life of the tab, permanently rather than provisionally. */
export function createTabMemorySecrets(): SecretStore {
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

export type { BrowserSqliteFactory };
