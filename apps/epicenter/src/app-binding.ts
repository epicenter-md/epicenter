/**
 * The host's own leaf of the capability handle applications already use.
 *
 * An application's background work runs here rather than in a window, because a
 * window nobody is looking at is suspended after a few minutes and a compiled
 * Bun process is not (ADR-0323). What makes that affordable is that the
 * application's code does not change: `createEpicenter` takes a binding, the
 * browser and desktop leaves already exist, and this is the third. The same
 * package runs in a tab, in a window, or here, and only the binding differs.
 *
 * This leaf is shorter than the desktop one, and the reason is the point. The
 * desktop leaf sends `sqlite-run` over HTTP so the host can reach the file; the
 * host IS that owner, so it holds the same connection the window's round trip
 * would have reached. Two writers on one database do not appear, because there
 * is one connection and the owner serializes it.
 *
 * **There is no Epicenter Data here.** The store is client-owned in every
 * runtime (ADR-0226, ADR-0227) and the host does not open one, so `openData`
 * fails rather than pretending. Background work gets SQLite, secrets, and the
 * network. An application whose background half needs the store is asking for
 * something ADR-0323 does not provide.
 */

import { AppError, type EpicenterBinding, SecretError } from '@epicenter/app';
import { Ok } from 'wellcrafted/result';
import type { AppSecretOwner } from './app-secrets.ts';
import type { BunAppStorage } from './app-storage.ts';

export type HostBindingOptions = {
	appId: string;
	storage: BunAppStorage;
	secrets: AppSecretOwner;
};

export function createHostBinding({
	appId,
	storage,
	secrets,
}: HostBindingOptions): EpicenterBinding {
	return {
		openData: async (definition) =>
			AppError.StorageFailed({
				cause: new Error(
					`The host holds no store, so '${definition.id}' cannot be opened here. Epicenter Data is client-owned in every runtime (ADR-0226), and a background half reaches SQLite, secrets, and the network (ADR-0323).`,
				),
			}),
		openSqlite: async (name) => {
			try {
				return Ok(await storage.open(appId, name));
			} catch (cause) {
				return AppError.StorageFailed({ cause });
			}
		},
		deleteSqlite: async (name) => {
			try {
				await storage.delete(appId, name);
				return Ok(undefined);
			} catch (cause) {
				return AppError.StorageFailed({ cause });
			}
		},
		secrets: {
			put: async (accountId, value) => {
				try {
					await secrets.put(appId, accountId, value);
					return Ok(undefined);
				} catch (cause) {
					return SecretError.StorageFailed({ cause });
				}
			},
			get: async (accountId) => {
				try {
					return Ok(await secrets.get(appId, accountId));
				} catch (cause) {
					return SecretError.StorageFailed({ cause });
				}
			},
			delete: async (accountId) => {
				try {
					await secrets.delete(appId, accountId);
					return Ok(undefined);
				} catch (cause) {
					return SecretError.StorageFailed({ cause });
				}
			},
		},
	};
}
