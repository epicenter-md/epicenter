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
 * **There is no Epicenter Data here, and there is nothing left to refuse.**
 * The store is client-owned in every runtime (ADR-0226, ADR-0227), so it left
 * the binding entirely (ADR-0339); this leaf used to carry an `openData` whose
 * whole body was a sentence explaining that it could not. Background work gets
 * SQLite, secrets, and the network. An application whose background half needs
 * the store is asking for something ADR-0323 does not provide, and it now says
 * so by having no `definition` to pass rather than by failing at the call.
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
		open: async (name) => {
			try {
				return Ok(await storage.open(appId, name));
			} catch (cause) {
				return AppError.StorageFailed({ cause });
			}
		},
		delete: async (name) => {
			try {
				await storage.delete(appId, name);
				return Ok(undefined);
			} catch (cause) {
				return AppError.StorageFailed({ cause });
			}
		},
		secrets: {
			put: async (label, value) => {
				try {
					await secrets.put(appId, label, value);
					return Ok(undefined);
				} catch (cause) {
					return SecretError.StorageFailed({ cause });
				}
			},
			get: async (label) => {
				try {
					return Ok(await secrets.get(appId, label));
				} catch (cause) {
					return SecretError.StorageFailed({ cause });
				}
			},
			delete: async (label) => {
				try {
					await secrets.delete(appId, label);
					return Ok(undefined);
				} catch (cause) {
					return SecretError.StorageFailed({ cause });
				}
			},
		},
	};
}
