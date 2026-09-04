/// <reference lib="dom" />

/**
 * The browser binding: origin-owned SQLite over OPFS in a worker, and secrets
 * that live exactly as long as the tab (ADR-0310).
 *
 * This is the reduced build. It has no keychain and no host, so it holds no
 * credential across a reload, deliberately and permanently: not `localStorage`,
 * not IndexedDB, and not encrypted in the page, because a key the page can
 * derive is a key anything in the origin can derive.
 *
 * **This leaf builds a binding, not a handle.** Nothing about an epicenter
 * varies by runtime; a Bun-owned file and a keychain do. So the leaf is what
 * varies, an application composes it, and one `createEpicenter` in
 * `@epicenter/app` serves every build.
 *
 * The runtime is still the import path, never a runtime test: a WebView cannot
 * be told from a tab by anything observable at runtime, so the build answers
 * it. An application that needs the owner its platform actually has reaches
 * this through its own `#platform/binding` seam.
 */

import { Ok } from 'wellcrafted/result';
import { createBrowserSqliteTransport } from './browser-sqlite.js';
import type { EpicenterBindingFactory, SecretStore } from './index.js';
import { createOwnedSqlite, unwrap } from './owner.js';

/**
 * One binding over what a browser tab can own, for whichever application asks.
 *
 * It answers with a function of `appId` rather than a built binding, because
 * that is the shape `createEpicenter` takes: the handle resolves the id and
 * hands it over, so the files and the keychain cannot be scoped to a different
 * application than the store (ADR-0339).
 *
 * The transport is built once, above the function, because one tab has one
 * OPFS and therefore one storage worker; the application scope is the name the
 * worker files under, exactly as it is for the Bun owner.
 *
 * `open` cannot fail here, which is the same thing the desktop leaf says: it
 * resolves a name to a handle rather than a connection, and whether the file
 * can be opened at all is answered by the first statement through it. Handing
 * back a `Result` anyway keeps one binding contract across runtimes.
 */
export function createBrowserBinding(): EpicenterBindingFactory {
	const request = createBrowserSqliteTransport();
	return (appId) => ({
		open: async (name) => Ok(createOwnedSqlite(request, appId, name)),
		delete: (name) =>
			unwrap(
				request({ kind: 'sqlite-delete', appId, name }),
				'sqlite-delete',
				() => undefined,
			),
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
