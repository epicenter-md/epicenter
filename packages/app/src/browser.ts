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
 * **This leaf builds a binding, not a handle.** It used to export its own
 * `createEpicenter`, which made the platform a property of the whole handle
 * and forced every application to select a constructor through `#platform/*`
 * even when it owned no file and no secret. Nothing about an epicenter varies
 * by runtime; a Bun-owned file and a keychain do. So the leaf is what varies,
 * an application composes it, and one `createEpicenter` in `@epicenter/app`
 * serves every build.
 *
 * The runtime is still the import path, never a runtime test: a WebView cannot
 * be told from a tab by anything observable at runtime, so the build answers
 * it. An application that needs the owner its platform actually has reaches
 * this through its own `#platform/binding`; one that owns neither names this
 * leaf directly, in one file, for both builds.
 */

import { Ok, tryAsync } from 'wellcrafted/result';
import { createBrowserSqliteOwner } from './browser-sqlite.js';
import { AppError, type EpicenterBinding, type SecretStore } from './index.js';

/**
 * One binding over what a browser tab can own, for whichever application asks.
 *
 * It answers with a function of `appId` rather than a built binding, because
 * that is the shape `createEpicenter` takes: the handle resolves the id and
 * hands it over, so the files and the keychain cannot be scoped to a different
 * application than the store (ADR-0339).
 */
export function createBrowserBinding(): (appId: string) => EpicenterBinding {
	const sqlite = createBrowserSqliteOwner();
	return (appId) => ({
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
	});
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
