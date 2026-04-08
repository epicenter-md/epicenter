import { env } from 'cloudflare:workers';
import type { EncryptionKeys } from '@epicenter/workspace';
import { type } from 'arktype';

/**
 * Validated shape of a single keyring entry.
 *
 * `version` is a positive integer identifying the key generation; `secret` is
 * the raw key material (typically base64-encoded via `openssl rand -base64 32`).
 */
const EncryptionEntry = type({
	version: 'number.integer > 0',
	secret: 'string',
});

/**
 * Parse a single `"version:secret"` string into a validated `EncryptionEntry`.
 *
 * Finds the first colon—everything before it is the version, everything after
 * is the secret (which may itself contain colons). Uses `ctx.error()` for
 * arktype-native error reporting when the colon delimiter is missing.
 */
const EncryptionEntryParser = type('string')
	.pipe((entry, ctx) => {
		const separatorIndex = entry.indexOf(':');
		if (separatorIndex === -1) return ctx.error('must be "version:secret"');
		return {
			version: Number(entry.slice(0, separatorIndex)),
			secret: entry.slice(separatorIndex + 1),
		};
	})
	.to(EncryptionEntry);

/**
 * Parse and validate the full ENCRYPTION_SECRETS env var into a sorted keyring.
 *
 * Input format: `"2:base64Secret2,1:base64Secret1"` (comma-separated entries).
 * Output: a non-empty array of `{ version, secret }` sorted by version descending
 * (highest version first—the current key for new encryptions).
 *
 * `.pipe.try()` catches any `TraversalError` thrown by `EncryptionEntryParser.assert()`
 * and wraps it as `ArkErrors`. The non-empty tuple `.to()` guarantees `keyring[0]`
 * is always defined. `.assert()` at module load throws a `TraversalError` if the
 * env var is missing or malformed—the worker will not serve requests until fixed.
 */
const EncryptionKeyring = type('string')
	.pipe.try((value) =>
		value
			.split(',')
			.map((entry) => EncryptionEntryParser.assert(entry))
			.sort((left, right) => right.version - left.version),
	)
	.to([EncryptionEntry, '...', EncryptionEntry.array()]);

/**
 * Module-scope keyring—parsed once when the worker loads.
 *
 * `cloudflare:workers` exposes `env` at module scope. Parsing here means a
 * malformed ENCRYPTION_SECRETS prevents the worker from loading at all rather
 * than failing on the first auth request.
 *
 * Uses the call operator (not `.assert()`) so validation errors are returned
 * as `ArkErrors` instead of thrown as `TraversalError`. This lets us wrap
 * them in a human-readable message with the expected format.
 */
const keyringResult = EncryptionKeyring(env.ENCRYPTION_SECRETS);
if (keyringResult instanceof type.errors) {
	throw new Error(
		`ENCRYPTION_SECRETS is missing or malformed. ` +
			`Expected format: "2:base64Secret2,1:base64Secret1" (comma-separated version:secret pairs). ` +
			`Generate a secret with: openssl rand -base64 32\n\n` +
			`Validation errors:\n${keyringResult.summary}`,
	);
}

// Arktype's .pipe.try() leaks ArkError into element unions that TS can't narrow
// through. Both the tuple validation (.to()) and the instanceof check above
// guarantee these are valid EncryptionEntry objects.
const keyring = keyringResult as Array<typeof EncryptionEntry.infer>;

/**
 * Derive a per-user 32-byte encryption key via two-step HKDF-SHA256.
 *
 * 1. SHA-256 the secret to get high-entropy root key material.
 * 2. Import as HKDF key and derive 256 bits with info="user:{userId}".
 *
 * Same inputs always produce the same key—deterministic, no storage needed.
 *
 * The info string is a domain-separation label for HKDF (RFC 5869 §3.2),
 * not a version identifier. If the derivation scheme ever changes, the blob
 * format version handles migration—not the info string.
 */
async function deriveUserKey(
	secret: string,
	userId: string,
): Promise<Uint8Array> {
	const rawKey = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(secret),
	);
	const hkdfKey = await crypto.subtle.importKey('raw', rawKey, 'HKDF', false, [
		'deriveBits',
	]);
	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new Uint8Array(0),
			info: new TextEncoder().encode(`user:${userId}`),
		},
		hkdfKey,
		256,
	);
	return new Uint8Array(derivedBits);
}

/** Convert bytes to a base64 string suitable for JSON transport. */
function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++)
		binary += String.fromCharCode(bytes[i]!);
	return btoa(binary);
}

/**
 * Derive per-user encryption keys for every version in the keyring.
 *
 * Called by `customSession()` on every `/auth/get-session` response.
 * Returns one `{ version, userKeyBase64 }` per keyring entry, sorted
 * highest-version-first (matching keyring order). HKDF derivation adds
 * <0.1ms per key—negligible next to the network round-trip.
 */
export async function deriveUserEncryptionKeys(
	userId: string,
): Promise<EncryptionKeys> {
	// keyring is guaranteed non-empty by the EncryptionKeyring tuple validation.
	// Promise.all returns T[] which TS can't narrow to the non-empty tuple.
	return Promise.all(
		keyring.map(async ({ version, secret }) => ({
			version,
			userKeyBase64: bytesToBase64(await deriveUserKey(secret, userId)),
		})),
	) as Promise<EncryptionKeys>;
}
