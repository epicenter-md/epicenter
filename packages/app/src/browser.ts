/// <reference lib="dom" />

/**
 * The browser binding: origin-owned SQLite over OPFS, and secrets that live
 * exactly as long as the tab (ADR-0310).
 *
 * This is the reduced build. It has no keychain and no host, so it holds no
 * credential across a reload, deliberately and permanently: not `localStorage`,
 * not IndexedDB, and not encrypted in the page, because a key the page can
 * derive is a key anything in the origin can derive.
 *
 * **This leaf builds the browser half of the handle.** The common constructor
 * remains in `@epicenter/app`; this leaf supplies the browser owner and keeps
 * that platform choice out of application code.
 *
 * The runtime is still the import path, never a runtime test: a WebView cannot
 * be told from a tab by anything observable at runtime, so the build answers
 * it. An application that needs the owner its platform actually has reaches
 * this through its own build-time platform seam.
 */

import type { DataDefinition } from '@epicenter/data/definition';
import { Ok, tryAsync } from 'wellcrafted/result';
import { createBrowserSqliteOwner } from './browser-sqlite.js';
import {
	AppError,
	createEpicenter,
	type Epicenter,
	type EpicenterBinding,
	type EpicenterDataOptions,
	type EpicenterScopeOptions,
	type SecretStore,
} from './index.js';

/**
 * One binding over what a browser tab can own for one application.
 */
function createBrowserBinding(appId: string): EpicenterBinding {
	const sqlite = createBrowserSqliteOwner();
	return {
		open: (name) =>
			tryAsync({
				try: () => sqlite.open(appId, name),
				catch: (cause) => AppError.StorageFailed({ cause }),
			}),
		delete: (name) =>
			tryAsync({
				try: () => sqlite.delete(appId, name),
				catch: (cause) => AppError.StorageFailed({ cause }),
			}),
		secrets: createTabMemorySecrets(),
	};
}

export function createBrowserEpicenter(
	options: EpicenterScopeOptions,
): Epicenter;
export function createBrowserEpicenter<
	const TDefinition extends DataDefinition,
>(
	options: EpicenterScopeOptions & EpicenterDataOptions<TDefinition>,
): Epicenter<TDefinition>;
export function createBrowserEpicenter<
	const TDefinition extends DataDefinition,
>(
	options: EpicenterScopeOptions & Partial<EpicenterDataOptions<TDefinition>>,
): Epicenter<TDefinition> {
	return createEpicenter({
		...options,
		binding: createBrowserBinding(options.appId),
	}) as Epicenter<TDefinition>;
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
