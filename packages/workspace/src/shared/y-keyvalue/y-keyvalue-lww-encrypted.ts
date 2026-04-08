/**
 * # Encrypted KV-LWW—Composition Wrapper
 *
 * Transparent encryption layer over `YKeyValueLww`. All CRDT logic (timestamps,
 * conflict resolution, pending/map architecture) stays in `YKeyValueLww`; this
 * module transforms values at the boundary.
 *
 * ## Why Composition Over Fork
 *
 * Yjs `ContentAny` stores entry objects by **reference**. `YKeyValueLww` relies
 * on `indexOf()` (strict `===`) to find entries in the Y.Array during conflict
 * resolution. A fork that decrypts into new objects breaks `indexOf`—the map
 * entries are no longer the same JS objects as the yarray entries.
 *
 * See `docs/articles/yjs-reference-equality-why-we-compose-encrypted-crdts.md`.
 *
 * ## Data Flow
 *
 * ```
 * set('tab-1', { url: '...' })
 *   ├── JSON.stringify → encryptValue → Uint8Array [fmt‖keyVer‖nonce‖ct‖tag]
 *   └── inner.set('tab-1', encryptedBlob)              ← CRDT source of truth
 *
 * get('tab-1')
 *   └── inner.get('tab-1') → decrypt on the fly        ← ~0.01ms per value
 * ```
 *
 * There is no plaintext cache. Every read decrypts from the inner store.
 * XChaCha20-Poly1305 decrypt of a small JSON blob is microseconds—caching
 * adds complexity (dual-map sync, diffAndEmit, transaction-gap fallback)
 * for negligible performance gain.
 *
 * ## Encryption Lifecycle
 *
 * Encryption is **one-way** by API surface—there is no
 * `deactivateEncryption()`. Once `activateEncryption()` is called, the
 * `encryption` state is set and no method clears it. The only reset
 * path is destroying the wrapper via `clearLocalData()`.
 *
 * ## Re-encryption on Activation
 *
 * When `activateEncryption()` is called, only **plaintext** entries are
 * re-encrypted. Existing encrypted blobs (even on older key versions) are
 * left alone—they're already safe. Old-version ciphertext is lazily migrated
 * on the next `set()` for that key.
 *
 * ## Error Containment
 *
 * The observer wraps decrypt with try/catch. A failed decrypt skips the entry
 * and logs a warning instead of throwing. This prevents one bad blob from
 * crashing all observation. `unreadableEntryCount` exposes the count.
 *
 * ## Related Modules
 *
 * - {@link ../crypto/index.ts}—Encryption primitives (encryptValue, decryptValue, isEncryptedBlob)
 * - {@link ./y-keyvalue-lww.ts}—Inner CRDT that handles conflict resolution (unaware of encryption)
 *
 * @module
 */
import type * as Y from 'yjs';
import {
	decryptValue,
	type EncryptedBlob,
	encryptValue,
	getKeyVersion,
	isEncryptedBlob,
} from '../crypto/index.js';
import {
	YKeyValueLww,
	type YKeyValueLwwChange,
	type YKeyValueLwwEntry,
} from './y-keyvalue-lww.js';

const textEncoder = new TextEncoder();
/** Transaction origin for re-encryption writes. Observer skips events with this origin. */
const REENCRYPT_ORIGIN = Symbol('re-encrypt');

/**
 * Change handler for the encrypted KV wrapper.
 *
 * Receives the Yjs transaction origin for real CRDT changes, or `undefined`
 * for synthetic events emitted during `activateEncryption()` (which have
 * no backing Yjs transaction).
 */
export type EncryptedKvObserver<T> = (
	changes: Map<string, YKeyValueLwwChange<T>>,
	origin: unknown,
) => void;

type EncryptionState = {
	keyring: ReadonlyMap<number, Uint8Array>;
	currentKey: Uint8Array;
	currentVersion: number;
};

/**
 * Return type of `createEncryptedYkvLww`. Same API surface as `YKeyValueLww<T>`
 * plus encryption-specific members (`unreadableEntryCount`, `activateEncryption`).
 * All values exposed through this type are **plaintext**—encryption is fully
 * transparent to consumers.
 */
export type EncryptedYKeyValueLww<T> = {
	set(key: string, val: T): void;
	get(key: string): T | undefined;
	has(key: string): boolean;
	delete(key: string): void;
	entries(): IterableIterator<[string, YKeyValueLwwEntry<T>]>;
	observe(handler: EncryptedKvObserver<T>): void;
	unobserve(handler: EncryptedKvObserver<T>): void;

	/**
	 * Activate encryption with a versioned keyring. The highest-version key
	 * becomes the current key for new encryptions. Decryption reads
	 * `getKeyVersion(blob)` to select the correct key from the keyring.
	 *
	 * There is no deactivation path—this is one-way by API surface.
	 * Calling again with a new keyring updates the active keys.
	 *
	 * Only plaintext entries are re-encrypted on activation. Existing
	 * encrypted blobs (even on older key versions) are left alone—they're
	 * already safe. Old-version ciphertext is lazily migrated on the next
	 * `set()` for that key.
	 *
	 * @param keyring Map from version number to 32-byte encryption key
	 */
	activateEncryption(keyring: ReadonlyMap<number, Uint8Array>): void;

	/**
	 * Unregister the inner observer and release resources. Call when this
	 * wrapper is no longer needed but the underlying Y.Array continues to exist.
	 */
	dispose(): void;

	/**
	 * Number of entries in the inner store that cannot be decrypted.
	 *
	 * When a key is active, this counts entries that failed to decrypt
	 * (corrupted blobs, wrong key version not in keyring). When no key
	 * is active, this counts all encrypted entries.
	 *
	 * Computed by iterating `inner.map` and counting undecryptable entries.
	 */
	readonly unreadableEntryCount: number;

	/**
	 * Iterate all decryptable entries. Decrypts on the fly from the inner
	 * store—there is no separate plaintext cache.
	 *
	 * TableHelper uses this for `getAll()`, `filter()`, `find()`, `clear()`.
	 * Entries that cannot be decrypted are silently omitted.
	 */
	readableEntries(): IterableIterator<[string, YKeyValueLwwEntry<T>]>;

	/** Count of decryptable entries. TableHelper uses this for `count()`. */
	readonly readableEntryCount: number;

	/** The underlying Y.Array. Contains **ciphertext** when a key is active. */
	readonly yarray: Y.Array<YKeyValueLwwEntry<EncryptedBlob | T>>;

	/** The Y.Doc that owns the array. */
	readonly doc: Y.Doc;
};

/**
 * Compose transparent encryption onto `YKeyValueLww` without forking CRDT logic.
 *
 * `YKeyValueLww` remains the single source for conflict resolution; this wrapper
 * only transforms values at the boundary (`set` encrypts, `get`/observer decrypts).
 *
 * When no key is available, all operations pass through without
 * encryption—zero overhead, identical to a plain `YKeyValueLww<T>`.
 *
 * @example
 * ```typescript
 * // Start in plaintext, transition to encrypted when key arrives
 * const kv = createEncryptedYkvLww<TabData>(yarray);
 * kv.set('tab-1', { url: '...' }); // stored as plaintext
 *
 * kv.activateEncryption(new Map([[1, encryptionKey]]));
 * kv.set('tab-2', { url: '...' }); // stored as EncryptedBlob
 * // tab-1 was re-encrypted during activation
 * ```
 */
export function createEncryptedYkvLww<T>(
	yarray: Y.Array<YKeyValueLwwEntry<EncryptedBlob | T>>,
	initialKeyring?: ReadonlyMap<number, Uint8Array>,
): EncryptedYKeyValueLww<T> {
	/**
	 * The inner LWW store. It sees `EncryptedBlob | T` as its value type—it
	 * doesn't know or care that some values are ciphertext. Timestamps, conflict
	 * resolution, and observer mechanics all live here.
	 */
	const inner = new YKeyValueLww<EncryptedBlob | T>(yarray);
	const changeHandlers = new Set<EncryptedKvObserver<T>>();

	/** Active encryption state. `undefined` = passthrough mode. */
	let encryption: EncryptionState | undefined;

	if (initialKeyring) {
		if (initialKeyring.size === 0)
			throw new Error('Keyring must contain at least one key');
		const version = Math.max(...initialKeyring.keys());
		const currentKey = initialKeyring.get(version);
		if (!currentKey) throw new Error(`Missing key for version ${version}`);
		encryption = {
			keyring: initialKeyring,
			currentKey,
			currentVersion: version,
		};
	}

	/**
	 * Best-effort blob decryption with keyring fallback.
	 *
	 * Tries currentKey first (most blobs use the latest version).
	 * On failure, reads the blob's embedded key version and tries
	 * the matching key from the keyring.
	 *
	 * Pure function—no logging, no side effects. Callers decide
	 * what to do with `undefined` (warn, skip, etc.).
	 *
	 * @param state - Defaults to the closure's `encryption`. Overridden by
	 *   `activateEncryption()` to compare before/after readability without
	 *   mutating the closure mid-iteration.
	 */
	const tryDecryptBlob = (
		blob: EncryptedBlob,
		aad: Uint8Array,
		state: EncryptionState | undefined = encryption,
	): string | undefined => {
		if (!state) return undefined;
		try {
			return decryptValue(blob, state.currentKey, aad);
		} catch {
			// Current key didn't work — try the blob's recorded key version
		}
		const versionKey = state.keyring.get(getKeyVersion(blob));
		if (!versionKey || versionKey === state.currentKey) return undefined; // Missing version, or same key we already tried
		try {
			return decryptValue(blob, versionKey, aad);
		} catch {
			return undefined;
		}
	};

	/**
	 * Attempt to decrypt an entry. Returns a plaintext entry on success,
	 * `undefined` on failure. When a key IS active and decryption still fails,
	 * logs a single warning with the entry key and actionable failure reason.
	 */
	const tryDecryptEntry = (
		key: string,
		entry: YKeyValueLwwEntry<EncryptedBlob | T>,
	): YKeyValueLwwEntry<T> | undefined => {
		if (!isEncryptedBlob(entry.val)) return { ...entry, val: entry.val as T }; // Plaintext — nothing to decrypt
		const json = tryDecryptBlob(entry.val, textEncoder.encode(key));
		if (json !== undefined) return { ...entry, val: JSON.parse(json) as T };
		if (!encryption) return undefined; // No key loaded yet — skip silently, activateEncryption() will catch up

		const blobVersion = getKeyVersion(entry.val);
		const isKnownKeyVersion = encryption.keyring.has(blobVersion);
		const reason = isKnownKeyVersion
			? 'wrong key material or corrupted blob'
			: `keyVersion=${blobVersion} not in keyring [${[...encryption.keyring.keys()].join(', ')}]`;
		console.warn(`[encrypted-kv] Failed to decrypt entry "${key}": ${reason}`);
		return undefined;
	};

	/** Silent decrypt—returns plaintext value or `undefined`. No console warning. */
	const tryDecryptValue = (
		raw: EncryptedBlob | T,
		aad: Uint8Array,
		state: EncryptionState | undefined = encryption,
	): T | undefined => {
		if (!isEncryptedBlob(raw)) return raw as T;
		const json = tryDecryptBlob(raw, aad, state);
		if (!json) return undefined;
		return JSON.parse(json) as T;
	};

	/** Count entries that can be decrypted (or are plaintext) with the current keyring. */
	const countDecryptable = (): number => {
		let count = 0;
		for (const [key, entry] of inner.map)
			if (tryDecryptValue(entry.val, textEncoder.encode(key)) !== undefined)
				count++;
		return count;
	};

	/** Iterate entries, decrypting each on the fly. Undecryptable entries are skipped. */
	const iterateDecrypted = function* (
		iterable: Iterable<[string, YKeyValueLwwEntry<EncryptedBlob | T>]>,
	): IterableIterator<[string, YKeyValueLwwEntry<T>]> {
		for (const [key, entry] of iterable) {
			const val = tryDecryptValue(entry.val, textEncoder.encode(key));
			if (val !== undefined) yield [key, { ...entry, val }];
		}
	};

	/**
	 * Inner observer. When entries change in the CRDT, decrypt and forward
	 * plaintext change events to registered handlers. Skips REENCRYPT_ORIGIN writes
	 * (those are internal re-encryption during activation, not user changes).
	 */
	const observer: Parameters<typeof inner.observe>[0] = (
		changes,
		transaction,
	) => {
		if (transaction.origin === REENCRYPT_ORIGIN) return;
		const decryptedChanges = new Map<string, YKeyValueLwwChange<T>>();
		for (const [key, change] of changes) {
			if (change.action === 'delete') {
				decryptedChanges.set(key, { action: 'delete' });
				continue;
			}
			const entry = inner.map.get(key);
			if (!entry) continue;
			const decrypted = tryDecryptEntry(key, entry);
			if (!decrypted) continue;
			decryptedChanges.set(key, {
				action: change.action,
				newValue: decrypted.val,
			});
		}
		if (decryptedChanges.size === 0) return;
		for (const handler of changeHandlers)
			handler(decryptedChanges, transaction.origin);
	};

	inner.observe(observer);

	return {
		set(key, val) {
			if (!encryption) {
				inner.set(key, val);
				return;
			}
			inner.set(
				key,
				encryptValue(
					JSON.stringify(val),
					encryption.currentKey,
					textEncoder.encode(key),
					encryption.currentVersion,
				),
			);
		},
		/**
		 * Get a decrypted value by key. Reads from the inner store and decrypts
		 * on the fly (~0.01ms for XChaCha20-Poly1305 on a small JSON blob).
		 */
		get(key) {
			const raw = inner.get(key);
			if (raw === undefined) return undefined;
			return tryDecryptValue(raw, textEncoder.encode(key));
		},
		has(key) {
			const raw = inner.get(key);
			if (raw === undefined) return false;
			return tryDecryptValue(raw, textEncoder.encode(key)) !== undefined;
		},
		delete(key) {
			inner.delete(key);
		},
		*entries() {
			yield* iterateDecrypted(inner.entries());
		},
		observe(handler) {
			changeHandlers.add(handler);
		},
		unobserve(handler) {
			changeHandlers.delete(handler);
		},
		activateEncryption(keyring) {
			if (keyring.size === 0)
				throw new Error('Keyring must contain at least one key');
			const previousEncryption = encryption;
			const nextVersion = Math.max(...keyring.keys());
			const nextKey = keyring.get(nextVersion);
			if (!nextKey) throw new Error(`Missing key for version ${nextVersion}`);
			const nextEncryption: EncryptionState = {
				keyring,
				currentKey: nextKey,
				currentVersion: nextVersion,
			};
			encryption = nextEncryption;

			const newlyReadable = new Map<string, T>();
			const plaintextToEncrypt: Array<{ key: string; val: T }> = [];
			for (const [key, entry] of inner.map) {
				if (isEncryptedBlob(entry.val)) {
					const before = tryDecryptValue(
						entry.val,
						textEncoder.encode(key),
						previousEncryption,
					);
					if (before !== undefined) continue;
					const after = tryDecryptValue(
						entry.val,
						textEncoder.encode(key),
						nextEncryption,
					);
					if (after !== undefined) newlyReadable.set(key, after);
					continue;
				}
				plaintextToEncrypt.push({ key, val: entry.val as T });
			}

			inner.doc.transact(() => {
				for (const { key: entryKey, val } of plaintextToEncrypt)
					inner.set(
						entryKey,
						encryptValue(
							JSON.stringify(val),
							nextEncryption.currentKey,
							textEncoder.encode(entryKey),
							nextEncryption.currentVersion,
						),
					);
			}, REENCRYPT_ORIGIN);

			if (newlyReadable.size === 0) return;
			const syntheticChanges = new Map<string, YKeyValueLwwChange<T>>();
			for (const [key, val] of newlyReadable)
				syntheticChanges.set(key, { action: 'add', newValue: val });
			for (const handler of changeHandlers)
				handler(syntheticChanges, undefined);
		},
		get unreadableEntryCount() {
			return inner.map.size - countDecryptable();
		},
		*readableEntries() {
			yield* iterateDecrypted(inner.entries());
		},
		get readableEntryCount() {
			return countDecryptable();
		},
		yarray: inner.yarray,
		doc: inner.doc,
		dispose() {
			inner.unobserve(observer);
			inner.dispose();
		},
	};
}
