/**
 * # Encryption Primitives
 *
 * XChaCha20-Poly1305 encryption for workspace data, using `@noble/ciphers` (Cure53-audited,
 * synchronous). Chosen because `set()` must remain synchronous across 394+ call sites.
 *
 * XChaCha20-Poly1305 was chosen over AES-256-GCM because: (1) 2.3x faster in pure JS
 * (468K vs 201K ops/sec for 64B payloads in @noble/ciphers), (2) 24-byte nonce is safe
 * for random generation (no collision risk), (3) aligned with libsodium and WireGuard.
 * See @noble/ciphers benchmarks.
 *
 * ## Encryption Flow (10,000ft View)
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  Auth Flow                                                         │
 * │  Server derives key from secret → sends base64 in session response │
 * │  Client decodes → applyEncryptionKeys() derives per-workspace keys │
 * └────────────────────────┬────────────────────────────────────────────┘
 * │  key: Uint8Array | undefined
 *                          ▼
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  Encrypted KV Wrapper (y-keyvalue-lww-encrypted.ts)                │
 * │                                                                     │
 * │  set(key, val)                                                      │
 * │    → JSON.stringify(val)                                            │
 * │    → encryptValue(json, key) → Uint8Array [fmt‖keyVer‖nonce‖ct‖tag]│
 * │    → encryptValue(json, key, aad?) for context binding             │
 * │    → inner CRDT stores EncryptedBlob (bare Uint8Array)             │
 * │                                                                     │
 * │  observer fires (inner CRDT change)                                │
 * │    → isEncryptedBlob(val)? decryptValue → JSON.parse → plaintext   │
 * │                                                                     │
 * │  get(key) → decrypt on the fly from inner store                    │
 * └─────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Key Sources
 *
 * | Mode            | Key derivation                                              | Server decrypts? |
 * |-----------------|-------------------------------------------------------------|------------------|
 * | Cloud (SaaS)    | HKDF(SHA-256(current ENCRYPTION_SECRETS entry), "user:{userId}") | Yes         |
 * |                 | → per-user key in session; client HKDF → per-workspace key  |                  |
 * | Self-hosted     | Same HKDF hierarchy, your secret                            | Only you         |
 * | No auth / local | key: undefined → passthrough                                | N/A              |
 *
 * ## Related Modules
 *
 * - {@link ../y-keyvalue/y-keyvalue-lww-encrypted.ts} — Composition wrapper that wires these primitives into the CRDT
 * - {@link ../y-keyvalue/y-keyvalue-lww.ts} — Underlying CRDT (unaware of encryption)
 *
 * @module
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Brand } from 'wellcrafted/brand';

const NONCE_LENGTH = 24;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 2;

/**
 * Minimum valid EncryptedBlob size: 2-byte header + 24-byte nonce + 16-byte auth tag.
 * An empty plaintext produces a blob of exactly this size.
 */
const MINIMUM_BLOB_SIZE = HEADER_LENGTH + NONCE_LENGTH + TAG_LENGTH;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encrypted blob stored directly in the CRDT as a bare Uint8Array.
 *
 * Uses XChaCha20-Poly1305 with a self-describing binary header. The format
 * version lives at byte 0, eliminating the old `{ v, ct }` JSON wrapper.
 * Yjs `writeAny` serializes `Uint8Array` natively as binary (type tag 116).
 *
 * v:1 binary layout:
 * ```
 *  Byte:  0         1         2                        26
 *         +---------+---------+------------------------+---------------------------+
 *         | format  | key     |        nonce           |    ciphertext + tag       |
 *         | version | version |      (24 bytes)        |    (variable + 16)        |
 *         +---------+---------+------------------------+---------------------------+
 *         |  0x01   | 0x01-FF | random (CSPRNG)        | XChaCha20-Poly1305 output |
 *         +---------+---------+------------------------+---------------------------+
 *
 *  Total: 1 + 1 + 24 + len(plaintext) + 16 bytes
 * ```
 *
 * Detection: `value instanceof Uint8Array && value.length >= 42` (minimum blob size).
 * User values in the CRDT are always JS objects (never Uint8Arrays),
 * so `instanceof Uint8Array` is the primary discriminant.
 *
 * @example
 * ```typescript
 * const blob: EncryptedBlob = encryptValue('secret', key);
 * blob[0]; // 1 (format version)
 * blob[1]; // 1 (key version, default)
 * blob.slice(2, 26); // 24-byte random nonce
 * blob.slice(26); // ciphertext + 16-byte Poly1305 tag
 * ```
 */
type EncryptedBlob = Uint8Array & Brand<'EncryptedBlob'>;

/**
 * Encrypt a plaintext string using XChaCha20-Poly1305.
 *
 * Generates a random 24-byte nonce for each encryption, ensuring that
 * encrypting the same plaintext with the same key produces different ciphertexts.
 * Returns a bare `Uint8Array` with a self-describing binary header:
 * `formatVersion(1) || keyVersion(1) || nonce(24) || ciphertext || tag(16)`.
 *
 * Yjs `writeAny` serializes `Uint8Array` natively as binary (type tag 116),
 * eliminating base64 overhead and the old `{ v, ct }` JSON wrapper.
 *
 * @param plaintext - The string to encrypt
 * @param aad - Optional additional authenticated data bound to ciphertext integrity
 * @param keyVersion - Key version embedded as byte 1. Currently written but not read
 *   during decryption—reserved for future keyring rotation. The caller is responsible
 *   for passing the correct version from the ENCRYPTION_SECRETS keyring.
 * @returns A bare Uint8Array: `[formatVersion, keyVersion, ...nonce(24), ...ciphertext, ...tag(16)]`
 *
 * @example
 * ```typescript
 * const key = randomBytes(32);
 * const encrypted = encryptValue('secret data', key);
 * encrypted[0]; // 1 (format version)
 * encrypted[1]; // 1 (key version)
 * ```
 */
export function encryptValue(
	plaintext: string,
	key: Uint8Array,
	aad?: Uint8Array,
	keyVersion: number = 1,
): EncryptedBlob {
	if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
	const nonce = randomBytes(NONCE_LENGTH);
	const cipher = aad
		? xchacha20poly1305(key, nonce, aad)
		: xchacha20poly1305(key, nonce);
	const data = textEncoder.encode(plaintext);
	const ciphertext = cipher.encrypt(data);

	// Pack formatVersion(1) || keyVersion(1) || nonce(24) || ciphertext || tag(16)
	const packed = new Uint8Array(2 + nonce.length + ciphertext.length);
	packed[0] = 1; // format version
	packed[1] = keyVersion;
	packed.set(nonce, 2);
	packed.set(ciphertext, 2 + nonce.length);

	return packed as EncryptedBlob;
}

/**
 * Decrypt an EncryptedBlob using XChaCha20-Poly1305.
 *
 * Validates the format version at `blob[0]` (must be 1), then reads `blob[1]`
 * as key version metadata, `blob[2..25]` as nonce, and `blob[26..]` as
 * ciphertext + 16-byte auth tag. Decrypts using the provided key.
 *
 * The format version check exists as a safety net for forward compatibility.
 * Today only v1 exists, but if a future client writes v2 blobs, this function
 * will throw a clear error instead of silently misinterpreting the binary layout.
 * Future format versions would add dispatch logic here.
 *
 * Key version (`blob[1]`) is NOT validated here—the caller is responsible for
 * selecting the correct key from the keyring via `getKeyVersion()`.
 *
 * @param blob - A branded EncryptedBlob (bare Uint8Array with format header)
 * @param key - The 32-byte Uint8Array encryption key used to encrypt the blob
 * @param aad - Optional additional authenticated data that must match encryption input
 * @returns The decrypted plaintext string
 * @throws If format version is unknown, auth tag is invalid, or decryption fails
 *
 * @example
 * ```typescript
 * const key = randomBytes(32);
 * const encrypted = encryptValue('secret data', key);
 * const decrypted = decryptValue(encrypted, key);
 * console.log(decrypted); // 'secret data'
 * ```
 */
export function decryptValue(
	blob: EncryptedBlob,
	key: Uint8Array,
	aad?: Uint8Array,
): string {
	if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');

	// Validate format version — today only v1 exists. Future versions would
	// dispatch to different decryption logic here instead of falling through.
	const formatVersion = blob[0];
	if (formatVersion !== 1) {
		throw new Error(
			`Unknown encryption format version: ${formatVersion}. This blob may require a newer client.`,
		);
	}

	// blob[1] = key version (caller responsibility to select correct key)
	const nonce = blob.slice(2, 2 + NONCE_LENGTH);
	const ciphertext = blob.slice(2 + NONCE_LENGTH);
	const cipher = aad
		? xchacha20poly1305(key, nonce, aad)
		: xchacha20poly1305(key, nonce);
	const data = cipher.decrypt(ciphertext);

	return textDecoder.decode(data);
}

/**
 * Read the key version from an EncryptedBlob without decrypting.
 *
 * The key version is stored at byte 1 of the blob and identifies which
 * secret from the ENCRYPTION_SECRETS keyring was used to encrypt this blob.
 *
 * Used by the encrypted KV wrapper for version-directed key lookup during
 * decryption. When the current key fails to decrypt a blob, the wrapper reads
 * the blob's key version via this function and looks up the matching key from
 * the active keyring—avoiding brute-force trial of every key.
 *
 * @param blob - An EncryptedBlob to read the key version from
 * @returns The key version number (1-255)
 */
export function getKeyVersion(blob: EncryptedBlob): number {
	return blob[1]!;
}
/**
 * Type guard to check if a value is a valid EncryptedBlob.
 *
 * Checks that the value is a `Uint8Array` with at least the minimum blob size
 * (2-byte header + 24-byte nonce + 16-byte auth tag = 42 bytes). User values
 * stored in the CRDT are always JS objects (from schema definitions), never
 * `Uint8Array` instances, so `instanceof Uint8Array` is the primary discriminant.
 *
 * The minimum-length check replaces the previous `value[0] === 1` format-version
 * check so that future format versions (v2, v3, etc.) are recognized as encrypted
 * blobs without updating this guard. Truncated or corrupted blobs that pass this
 * check will fail during `decryptValue()` and get quarantined by the encrypted
 * wrapper's error containment—they are not silently misinterpreted.
 *
 * @param value - The value to check
 * @returns True if value is a valid EncryptedBlob, false otherwise
 *
 * @example
 * ```typescript
 * const data = crdt.get('key');
 * if (isEncryptedBlob(data)) {
 *   const decrypted = decryptValue(data, key);
 * }
 * ```
 */
export function isEncryptedBlob(value: unknown): value is EncryptedBlob {
	return value instanceof Uint8Array && value.length >= MINIMUM_BLOB_SIZE;
}

/**
 * Derive a per-workspace 256-bit encryption key from a user key via HKDF-SHA256.
 *
 * This is the second level of a two-level key hierarchy:
 * 1. **User key** (input)—from any source (server HKDF, PBKDF2 password, cache)
 * 2. **Workspace key** (output)—`HKDF(userKey, "workspace:{workspaceId}")`
 *
 * The separation ensures each workspace gets an independent key even from the same
 * user key. Compromising one workspace key reveals nothing about other workspaces.
 *
 * **Called internally by `applyEncryptionKeys()`**: You typically don't call this directly.
 * The workspace client decodes transport keys, calls `deriveWorkspaceKey()` for each,
 * and passes the resulting keyring to `activateEncryption()`. Exported for testing.
 *
 * Deterministic—same inputs always produce the same key. No storage needed.
 * Uses synchronous HKDF-SHA256 from `@noble/hashes`, so workspace runtime unlock
 * can derive and apply the key immediately before any cache persistence is awaited.
 *
 * The info string is a domain-separation label for HKDF (RFC 5869 §3.2),
 * not a version identifier. If the derivation scheme ever changes (hash
 * algorithm, salt policy), the blob format version handles migration—not
 * the info string. Vault Transit, Signal Protocol, libsodium, and AWS KMS
 * all use unversioned derivation context strings.
 *
 * @param userKey - A 32-byte Uint8Array user key (root key, NOT a workspace-specific key)
 * @param workspaceId - The workspace identifier (e.g. "tab-manager")
 * @returns A 32-byte Uint8Array per-workspace encryption key
 *
 * @example
 * ```typescript
 * // Called internally by workspace.applyEncryptionKeys():
 * //   for each key: deriveWorkspaceKey(userKey, id) → keyring
 * //   then: store.activateEncryption(keyring)
 *
 * // Direct usage (testing or manual key management):
 * const userKey = base64ToBytes(session.userKeyBase64);
 * const wsKey = deriveWorkspaceKey(userKey, 'tab-manager');
 * ```
 */
export function deriveWorkspaceKey(
	userKey: Uint8Array,
	workspaceId: string,
): Uint8Array {
	return hkdf(
		sha256,
		userKey,
		new Uint8Array(0),
		textEncoder.encode(`workspace:${workspaceId}`),
		32,
	);
}

/**
 * Convert a Uint8Array to a base64-encoded string.
 *
 * Builds a binary string via loop instead of `String.fromCharCode(...bytes)`
 * to avoid stack overflow on large inputs (spread hits max call stack at ~65K bytes).
 *
 * @param bytes - The bytes to encode
 * @returns A base64-encoded string
 *
 * @example
 * ```typescript
 * const bytes = new Uint8Array([1, 2, 3]);
 * const base64 = bytesToBase64(bytes);
 * console.log(base64); // 'AQID'
 * ```
 */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary);
}

/**
 * Convert a base64-encoded string to a Uint8Array.
 *
 * Uses the built-in `atob` function with proper handling of binary data
 * via `charCodeAt`. Safe for all byte values (0-255).
 *
 * @param base64 - The base64-encoded string
 * @returns A Uint8Array containing the decoded bytes
 *
 * @example
 * ```typescript
 * const base64 = 'AQID';
 * const bytes = base64ToBytes(base64);
 * console.log(bytes); // Uint8Array(3) [ 1, 2, 3 ]
 * ```
 */
export function base64ToBytes(base64: string): Uint8Array {
	const binaryString = atob(base64);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}

export type { EncryptedBlob };
