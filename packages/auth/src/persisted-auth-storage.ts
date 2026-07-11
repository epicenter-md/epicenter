import { PersistedAuth } from './auth-types.js';

/**
 * Storage adapter for the single `PersistedAuth` record (grant + identity).
 *
 * `initial` is the record read once at boot; the auth runtime reads it exactly
 * once, at construction, to seed its state machine, and never re-reads, so it
 * is a synchronous snapshot rather than a live getter. Runtimes whose store is
 * async (an extension's `chrome.storage`, a file) pre-load through
 * {@link loadPersistedAuthStorage} so `initial` stays synchronous.
 *
 * `set` is the only write path. No watch hook: cross-context sign-out
 * propagates via the server (the next bearer-bearing call hits a revoked token
 * and reauth-requires organically). The server is the authority; brief
 * cross-tab desync is acceptable.
 */
export type PersistedAuthStorage = {
	initial: PersistedAuth | null;
	set(value: PersistedAuth | null): void | Promise<void>;
};

/**
 * Decode a stored record string into a `PersistedAuth`, or `null` when the
 * record is absent, not JSON, or fails schema validation. The single owner of
 * the "corrupt or legacy record reads as signed out" rule, shared by every
 * storage adapter whose substrate frames the record as a string.
 */
export function parsePersistedAuth(raw: string | null): PersistedAuth | null {
	if (raw === null) return null;
	try {
		return PersistedAuth.assert(JSON.parse(raw));
	} catch {
		return null;
	}
}

/**
 * Encode a record for storage. Re-validates before writing so an unvalidated
 * value can never reach durable storage.
 */
export function serializePersistedAuth(value: PersistedAuth): string {
	return JSON.stringify(PersistedAuth.assert(value));
}

/**
 * Build a {@link PersistedAuthStorage} over a synchronous Web `Storage`
 * (`localStorage` or `sessionStorage`, in a browser tab or a Tauri webview).
 *
 * `get` returns `null` on a missing, non-JSON, or schema-invalid record, so a
 * corrupt record reads as signed-out instead of throwing. `set(null)` removes
 * the key. Write failures (`QuotaExceededError`, or `setItem` throwing in
 * private-mode Safari) are intentionally propagated rather than swallowed: a
 * credential that could not be persisted must fail the sign-in or refresh that
 * produced it, not silently look saved.
 *
 * `storage` is required, matching the OAuth launcher call sites that already
 * pass `window.localStorage` / `window.sessionStorage` explicitly. Keeping the
 * dependency explicit stops this framework-agnostic helper from reaching for a
 * `window` global of its own, which would also break under SSR import.
 */
export function createWebStoragePersistedAuthStorage({
	key,
	storage,
}: {
	key: string;
	storage: Storage;
}): PersistedAuthStorage {
	return {
		initial: parsePersistedAuth(storage.getItem(key)),
		set(value) {
			if (value === null) {
				storage.removeItem(key);
				return;
			}
			storage.setItem(key, serializePersistedAuth(value));
		},
	};
}

/**
 * Build a persisted-auth adapter from an already-loaded serialized snapshot.
 *
 * Desktop bootstraps use this when the native host resolves an asynchronous
 * credential store before the application module graph starts. The snapshot
 * stays synchronous for auth construction, while later writes continue to the
 * native store without copying the grant into Web Storage.
 */
export function createSerializedPersistedAuthStorage({
	initial,
	write,
}: {
	initial: string | null;
	write: (serialized: string | null) => void | Promise<void>;
}): PersistedAuthStorage {
	return {
		initial: parsePersistedAuth(initial),
		set(value) {
			return write(value === null ? null : serializePersistedAuth(value));
		},
	};
}

/**
 * Pre-load an async-backed record into a synchronous {@link PersistedAuthStorage}.
 *
 * The auth runtime reads `initial` once, synchronously, at construction, so an
 * async store cannot satisfy the contract directly. Await this before
 * constructing the client (the app's existing readiness gate is the natural
 * place); `initial` is the value read at load time, and `set()` forwards writes
 * to the store. Write failures propagate, matching the Web Storage adapter.
 *
 * @param store The async backing store. `read` returns the serialized record
 * (or `null` when absent); `write` persists a serialized record, or removes it
 * when passed `null`. It traffics only in opaque strings, never the record
 * shape.
 */
export async function loadPersistedAuthStorage(store: {
	read: () => Promise<string | null>;
	write: (serialized: string | null) => Promise<void>;
}): Promise<PersistedAuthStorage> {
	return createSerializedPersistedAuthStorage({
		initial: await store.read(),
		write: store.write,
	});
}
