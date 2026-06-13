/// <reference lib="dom" />

/**
 * `wipeLocalStorage`: delete every `(server, ownerId)`-scoped IndexedDB
 * database on the current browser profile.
 *
 * Enumerates `indexedDB.databases()` and clears every entry whose name
 * starts with the durable prefix produced by {@link getOwnedYjsPrefix} for
 * the given `(server, ownerId)` pair. This is a free function with no auth
 * coupling: the caller (sign-out handler, "delete my local data" button,
 * admin migration) passes the pair explicitly.
 *
 * Belt-and-suspenders with an explicit guid list is unnecessary: every
 * encrypted IDB database is created under the owner prefix, and the prefix
 * scan catches all of them.
 *
 * No-ops gracefully when `indexedDB.databases()` is unavailable (older
 * browsers): nothing to enumerate means nothing to delete here.
 *
 * @module
 */

import type { OwnerId } from '@epicenter/identity';
import { clearDocument } from 'y-indexeddb';
import { createOwnedYjsKey, getOwnedYjsPrefix } from './local-yjs-key.js';

/**
 * Delete every encrypted IndexedDB database owned by `(server, ownerId)` on
 * this browser profile.
 *
 * @example
 * ```ts
 * await wipeLocalStorage({ server: signedIn.server, ownerId: signedIn.ownerId });
 * ```
 */
export async function wipeLocalStorage({
	server,
	ownerId,
}: {
	server: string;
	ownerId: OwnerId;
}): Promise<void> {
	const prefix = getOwnedYjsPrefix(server, ownerId);
	if (!('databases' in indexedDB)) return;
	const databases = await indexedDB.databases().catch(() => []);
	const names = databases
		.map((db) => db.name)
		.filter(
			(name): name is string =>
				typeof name === 'string' && name.startsWith(prefix),
		);
	await Promise.all(names.map((name) => clearDocument(name)));
}

/**
 * Delete the encrypted IndexedDB database backing a single Y.Doc, addressed by
 * its `(server, ownerId, guid)` tuple.
 *
 * The single-doc counterpart to {@link wipeLocalStorage}: where wipe drops every
 * database under the owner prefix, this drops exactly one. It reuses
 * {@link createOwnedYjsKey}, the same name builder `attachLocalStorage` uses to
 * create the database, so the delete path can never drift from the create path.
 *
 * Idempotent: deleting a database that does not exist is a no-op. The caller
 * must ensure the doc is no longer mounted (its `Y.Doc` destroyed and its
 * storage attachment disposed) before clearing, otherwise a still-open
 * persistence writer can recreate the database after deletion.
 *
 * @example
 * ```ts
 * await clearLocalStorageForDoc({
 *   server: signedIn.server,
 *   ownerId: signedIn.ownerId,
 *   guid: childDocGuid,
 * });
 * ```
 */
export async function clearLocalStorageForDoc({
	server,
	ownerId,
	guid,
}: {
	server: string;
	ownerId: OwnerId;
	guid: string;
}): Promise<void> {
	await clearDocument(createOwnedYjsKey(server, ownerId, guid));
}
