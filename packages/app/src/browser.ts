/// <reference lib="dom" />

/**
 * The standalone browser leaf: IndexedDB data, origin-owned SQLite, and
 * secrets that live exactly as long as the tab (ADR-0310).
 *
 * This is the reduced build. It has no keychain and no host, so it holds no
 * credential across a reload, deliberately and permanently: not `localStorage`,
 * not IndexedDB, and not encrypted in the page, because a key the page can
 * derive is a key anything in the origin can derive.
 *
 * The runtime is this import path, and the name never carries it (ADR-0339).
 * An application selects the leaf through the `#platform/*` condition its
 * build already uses for auth; a build that forgot to fails to resolve rather
 * than silently running the wrong owner.
 */

import type { DataDefinition } from '@epicenter/data/definition';
import { Ok, tryAsync } from 'wellcrafted/result';
import { createBrowserSqliteOwner } from './browser-sqlite.js';
import {
	AppError,
	type AppSqliteDatabase,
	createEpicenter as createEpicenterWith,
	type Epicenter,
	type EpicenterBinding,
	type EpicenterDataOptions,
	type SecretStore,
} from './index.js';

type BrowserSqliteOwner = {
	open(appId: string, name: string): Promise<AppSqliteDatabase>;
	delete(appId: string, name: string): Promise<void>;
};

export type CreateBrowserEpicenterOptions = {
	appId: string;
	/** The SQLite owner, which only this package's own test replaces. */
	sqlite?: BrowserSqliteOwner;
};

export function createEpicenter(
	options: CreateBrowserEpicenterOptions,
): Epicenter;
export function createEpicenter<const TDefinition extends DataDefinition>(
	options: CreateBrowserEpicenterOptions & EpicenterDataOptions<TDefinition>,
): Epicenter<TDefinition>;
/** One handle over what a browser tab can own, scoped to `appId`. */
export function createEpicenter<const TDefinition extends DataDefinition>(
	options: CreateBrowserEpicenterOptions &
		Partial<EpicenterDataOptions<TDefinition>>,
): Epicenter<TDefinition> {
	// The cast is the overload pair collapsing into one implementation, which
	// TypeScript cannot follow through a conditional return type. The two public
	// signatures above are what a caller sees, and they are exact.
	return createEpicenterWith({
		...options,
		binding: createBrowserBinding(options),
	} as never) as Epicenter<TDefinition>;
}

function createBrowserBinding(options: {
	appId: string;
	sqlite?: BrowserSqliteOwner;
}): EpicenterBinding {
	const sqlite = options.sqlite ?? createBrowserSqliteOwner();
	return {
		open: (name) =>
			tryAsync({
				try: () => sqlite.open(options.appId, name),
				catch: (cause) => AppError.StorageFailed({ cause }),
			}),
		delete: (name) =>
			tryAsync({
				try: () => sqlite.delete(options.appId, name),
				catch: (cause) => AppError.StorageFailed({ cause }),
			}),
		secrets: createTabMemorySecrets(),
	};
}

/** In memory, for the life of the tab, permanently rather than provisionally. */
function createTabMemorySecrets(): SecretStore {
	const values = new Map<string, string>();
	return {
		put: async (label, value) => {
			values.set(label, value);
			return Ok(undefined);
		},
		get: async (label) => Ok(values.get(label) ?? null),
		delete: async (label) => {
			values.delete(label);
			return Ok(undefined);
		},
	};
}
