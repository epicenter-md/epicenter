/**
 * The single owner of OAuth token encryption at rest.
 *
 * TikTok's refresh token is a year-long bearable credential that can publish as
 * the creator, so it never sits in Postgres as plaintext. Every token column
 * holds a versioned envelope:
 *
 *     v<n>.<base64url iv>.<base64url ciphertext+tag>
 *
 * AES-256-GCM via WebCrypto, which both the Worker and Bun provide natively.
 * GCM authenticates the ciphertext, so a tampered row fails to decrypt rather
 * than yielding attacker-chosen bytes.
 *
 * Key material is its OWN binding, deliberately not `BETTER_AUTH_SECRET`.
 * Reusing the session-signing secret would tie two unrelated blast radii
 * together: rotating it to invalidate sessions would strand every stored TikTok
 * grant, and a leak of either would become a leak of both.
 *
 * Rotation is the version tag. Keys arrive as `TIKTOK_TOKEN_ENCRYPTION_KEY`
 * (version 1) and optional `TIKTOK_TOKEN_ENCRYPTION_KEY_V2` (version 2);
 * encryption always uses the highest configured version while decryption
 * accepts any configured one, so a rotation is: add the new key, let refreshes
 * re-encrypt rows forward, then drop the old key. An envelope whose version has
 * no configured key fails closed with a named error rather than being treated
 * as unreadable-but-fine.
 */

import { defineErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';

export const TokenCipherError = defineErrors({
	/** The configured key material is not a usable 32-byte AES key. */
	InvalidKeyMaterial: ({
		version,
		reason,
	}: {
		version: number;
		reason: string;
	}) => ({
		message: `TikTok token encryption key v${version} is unusable: ${reason}`,
		version,
		reason,
	}),
	/** No key is configured at all, so tokens could only be stored in the clear. */
	NoKeyConfigured: () => ({
		message:
			'TIKTOK_TOKEN_ENCRYPTION_KEY is not set: refusing to store TikTok tokens without encryption at rest.',
	}),
	/** The stored value is not a `v<n>.<iv>.<ct>` envelope. */
	MalformedEnvelope: () => ({
		message: 'Stored TikTok token is not a recognizable encrypted envelope.',
	}),
	/** The envelope names a key version this deployment no longer configures. */
	UnknownKeyVersion: ({ version }: { version: number }) => ({
		message: `Stored TikTok token was encrypted with key v${version}, which is not configured. Restore that key or reconnect the account.`,
		version,
	}),
	/** Authentication failed: wrong key, or the row was tampered with. */
	DecryptionFailed: ({ version }: { version: number }) => ({
		message: `Stored TikTok token failed authenticated decryption under key v${version}.`,
		version,
	}),
});
export type TokenCipherError = import('wellcrafted/error').InferErrors<
	typeof TokenCipherError
>;

/** Raw key material as it arrives from bindings, by version number. */
export type TokenKeyMaterial = { version: number; base64Key: string };

const ALGORITHM = 'AES-GCM';
/** 96 bits: the IV length GCM is defined for and the only one WebCrypto accelerates. */
const IV_BYTES = 12;
const KEY_BYTES = 32;

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/**
 * Returns `Uint8Array<ArrayBuffer>` rather than the default
 * `Uint8Array<ArrayBufferLike>`: WebCrypto's `BufferSource` excludes
 * `SharedArrayBuffer`-backed views, so the buffer is allocated explicitly.
 */
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/');
	try {
		const binary = atob(padded);
		const bytes = new Uint8Array(new ArrayBuffer(binary.length));
		for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

/**
 * Parse an envelope into its parts without touching crypto. Split with a limit
 * of 3 so a base64url ciphertext can never be mistaken for extra segments
 * (base64url has no `.`, but the parse should not depend on that).
 */
function parseEnvelope(envelope: string): Result<
	{
		version: number;
		iv: Uint8Array<ArrayBuffer>;
		ciphertext: Uint8Array<ArrayBuffer>;
	},
	TokenCipherError
> {
	const parts = envelope.split('.');
	if (parts.length !== 3) return TokenCipherError.MalformedEnvelope();
	const [versionTag, ivPart, ciphertextPart] = parts as [
		string,
		string,
		string,
	];
	if (!/^v[1-9]\d*$/.test(versionTag))
		return TokenCipherError.MalformedEnvelope();
	const version = Number(versionTag.slice(1));
	const iv = fromBase64Url(ivPart);
	const ciphertext = fromBase64Url(ciphertextPart);
	if (!iv || iv.length !== IV_BYTES || !ciphertext || ciphertext.length === 0) {
		return TokenCipherError.MalformedEnvelope();
	}
	return Ok({ version, iv, ciphertext });
}

export type TokenCipher = {
	/** The version new envelopes are written under. */
	readonly activeVersion: number;
	encrypt(plaintext: string): Promise<Result<string, TokenCipherError>>;
	decrypt(envelope: string): Promise<Result<string, TokenCipherError>>;
	/**
	 * Whether an envelope is already at the active version. A `false` here is the
	 * rotation signal: the next write re-encrypts it forward.
	 */
	isCurrent(envelope: string): boolean;
};

/**
 * Build the cipher from whatever key versions this deployment configures.
 *
 * Async because `crypto.subtle.importKey` is, and eager because a
 * misconfigured key must fail at mount time rather than at the first publish.
 */
export async function createTokenCipher(
	keys: readonly TokenKeyMaterial[],
): Promise<Result<TokenCipher, TokenCipherError>> {
	if (keys.length === 0) return TokenCipherError.NoKeyConfigured();

	const imported = new Map<number, CryptoKey>();
	for (const { version, base64Key } of keys) {
		const raw = fromBase64Url(base64Key.trim());
		if (!raw) {
			return TokenCipherError.InvalidKeyMaterial({
				version,
				reason: 'not valid base64',
			});
		}
		if (raw.length !== KEY_BYTES) {
			return TokenCipherError.InvalidKeyMaterial({
				version,
				reason: `expected ${KEY_BYTES} bytes of key material, got ${raw.length}`,
			});
		}
		imported.set(
			version,
			await crypto.subtle.importKey('raw', raw, ALGORITHM, false, [
				'encrypt',
				'decrypt',
			]),
		);
	}

	const activeVersion = Math.max(...imported.keys());
	// Guarded by the import loop above, which inserts every version it iterates.
	const activeKey = imported.get(activeVersion) as CryptoKey;

	return Ok({
		activeVersion,

		async encrypt(plaintext) {
			const iv = crypto.getRandomValues(
				new Uint8Array(new ArrayBuffer(IV_BYTES)),
			);
			const ciphertext = await crypto.subtle.encrypt(
				{ name: ALGORITHM, iv },
				activeKey,
				new TextEncoder().encode(plaintext),
			);
			return Ok(
				`v${activeVersion}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`,
			);
		},

		async decrypt(envelope) {
			const { data: parsed, error } = parseEnvelope(envelope);
			if (error) return Err(error);
			const key = imported.get(parsed.version);
			if (!key) {
				return TokenCipherError.UnknownKeyVersion({ version: parsed.version });
			}
			try {
				const plaintext = await crypto.subtle.decrypt(
					{ name: ALGORITHM, iv: parsed.iv },
					key,
					parsed.ciphertext,
				);
				return Ok(new TextDecoder().decode(plaintext));
			} catch {
				// GCM authentication failure. The cause carries nothing useful and
				// could only echo key material into a log, so it is dropped.
				return TokenCipherError.DecryptionFailed({ version: parsed.version });
			}
		},

		isCurrent(envelope) {
			const { data: parsed } = parseEnvelope(envelope);
			return parsed?.version === activeVersion;
		},
	});
}
